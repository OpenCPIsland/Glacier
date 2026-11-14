/**
 * CDN content releases: a folder of Addressables bundles the island client
 * downloads instead of its embedded copies. A release is made by importing
 * the client generator's Export/www tree (CreateAssetBundles Step 4):
 *
 *   www/<n>/ClientBundles/<platform>/<hash>.unity3d   the bundles
 *   www/<n>/ClientManifestDirectory.json              names each platform's manifest bundle
 *
 * and is immutable afterwards. Layout on disk:
 *
 *   <releasesDir>/<id>/release.json   { id, files: {path: {crc}}, manifests: {platform: path} }
 *   <releasesDir>/<id>/files/<path>   the bundle bytes
 *
 * Only files listed in release.json are ever served. Doesn't touch the database.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CDN_PLATFORMS, isReleaseId } from "./cdnManifest.ts";
import { extractZip, type ZipLimits } from "./zipExtract.ts";

export { isReleaseId };

export interface Release {
    id: string;
    /** Path under the release (always ClientBundles/...) → CRC32 as uppercase hex, the form the manifest's "crc" uses. */
    files: Record<string, { crc?: string; sha256?: string; size?: number }>;
    /** Client platform → path of that platform's content-manifest bundle. Empty for an Addressables release. */
    manifests: Record<string, string>;
    /**
     * Addressables release only: Unity build target folder (StandaloneLinux64, Android, ...) →
     * its catalog file and the 32 hex characters in its .hash file. Files are keyed <Platform>/<file>.
     */
    platforms?: Record<string, { catalog: string; hash: string }>;
}

/** Unity build targets a release may contain. iOS and WebGL are out of scope. */
export const ADDRESSABLES_PLATFORMS = ["StandaloneLinux64", "StandaloneWindows64", "StandaloneOSX", "Android"] as const;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const CATALOG = /^(catalog_[A-Za-z0-9_.-]+)\.(bin|json)$/;
const HASH32 = /^[0-9a-f]{32}$/;

const BUNDLE_PATH = /^ClientBundles\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.unity3d$/;
const crc32 = (b: Uint8Array) => Bun.hash.crc32(b).toString(16).toUpperCase().padStart(8, "0");

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
    }
    return out;
}

/** Validates and copies the export tree into <releasesDir>/<id>. Throws, leaving nothing behind, if anything is wrong. */
export function importRelease(srcDir: string, releasesDir: string, id: string): Release {
    if (!isReleaseId(id)) throw new Error(`bad release id ${JSON.stringify(String(id).slice(0, 40))}`);
    const dest = join(releasesDir, id);
    if (existsSync(dest)) throw new Error(`release ${id} already exists`);
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) throw new Error("export folder not found");

    const all = walk(srcDir).map((p) => ({ p, rel: relative(srcDir, p).split(sep).join("/") }));
    if (all.some((f) => /^[^/]+\/catalog_[^/]*$/.test(f.rel) || (ADDRESSABLES_PLATFORMS as readonly string[]).includes(f.rel.split("/")[0]!))) return importAddressables(all, releasesDir, id);
    const dirFiles = all.filter((f) => /^[^/]+\/ClientManifestDirectory\.json$/.test(f.rel));
    if (dirFiles.length !== 1) throw new Error(`expected one <n>/ClientManifestDirectory.json in the export, found ${dirFiles.length}`);

    // Bundles live under <n>/ClientBundles; drop the leading <n>/.
    const files: Record<string, { crc: string }> = {};
    const sources = new Map<string, string>();
    for (const f of all) {
        const m = /^[^/]+\/(ClientBundles\/.+)$/.exec(f.rel);
        if (!m || !BUNDLE_PATH.test(m[1]!)) continue;
        files[m[1]!] = { crc: crc32(readFileSync(f.p)) };
        sources.set(m[1]!, f.p);
    }
    if (sources.size === 0) throw new Error("export has no .unity3d bundles under ClientBundles");

    let directory: any;
    try { directory = JSON.parse(readFileSync(dirFiles[0]!.p, "utf8")); } catch { throw new Error("ClientManifestDirectory.json isn't valid JSON"); }
    if (!directory || !Array.isArray(directory.directory)) throw new Error("ClientManifestDirectory.json has no directory list");
    const manifests: Record<string, string> = {};
    for (const e of directory.directory) {
        const platform = String(e?.platform);
        const url = String(e?.url);
        if (!(CDN_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`unknown platform ${JSON.stringify(platform.slice(0, 40))}`);
        if (!files[url]) throw new Error(`manifest bundle for ${platform} is missing from the export: ${JSON.stringify(url.slice(0, 80))}`);
        manifests[platform] = url;
    }
    if (Object.keys(manifests).length === 0) throw new Error("ClientManifestDirectory.json lists no platforms");

    return writeRelease({ id, files, manifests }, sources, releasesDir);
}

/** "catalog_1.17.0.bin" → "1.17.0". */
export const catalogVersion = (catalog: string): string => catalog.replace(/^catalog_/, "").replace(/\.(bin|json)$/, "");

function importAddressables(all: { p: string; rel: string }[], releasesDir: string, id: string): Release {
    const files: Release["files"] = {};
    const platforms: NonNullable<Release["platforms"]> = {};
    const sources = new Map<string, string>();
    const byPlatform = new Map<string, { p: string; name: string }[]>();
    for (const f of all) {
        const parts = f.rel.split("/");
        const shown = JSON.stringify(f.rel.slice(0, 80));
        if (parts.length !== 2) throw new Error(`unexpected file ${shown}: files go directly in a <Platform> folder`);
        const [plat, name] = parts as [string, string];
        if (!(ADDRESSABLES_PLATFORMS as readonly string[]).includes(plat)) throw new Error(`unsupported platform folder ${JSON.stringify(plat.slice(0, 40))}`);
        if (!SAFE_NAME.test(name)) throw new Error(`unsafe file name ${shown}`);
        byPlatform.set(plat, [...(byPlatform.get(plat) ?? []), { p: f.p, name }]);
    }
    for (const [plat, list] of byPlatform) {
        const catalogs = list.filter((f) => CATALOG.test(f.name));
        if (catalogs.length !== 1) throw new Error(`${plat}: expected exactly one catalog, found ${catalogs.length}`);
        const stem = CATALOG.exec(catalogs[0]!.name)![1]!;
        const hashFile = list.find((f) => f.name === `${stem}.hash`);
        if (!hashFile) throw new Error(`${plat}: ${stem} has no .hash file`);
        const hash = readFileSync(hashFile.p, "utf8").trim();
        if (!HASH32.test(hash)) throw new Error(`${plat}: .hash file isn't 32 lowercase hex characters`);
        for (const f of list) {
            if (f !== catalogs[0] && f !== hashFile && !f.name.endsWith(".bundle")) throw new Error(`${plat}: unexpected file ${JSON.stringify(f.name)}`);
            const bytes = readFileSync(f.p);
            files[`${plat}/${f.name}`] = { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), size: bytes.length };
            sources.set(`${plat}/${f.name}`, f.p);
        }
        platforms[plat] = { catalog: catalogs[0]!.name, hash };
    }
    // One release serves one client version, and the version is in the catalog name.
    const versions = new Set(Object.values(platforms).map((p) => catalogVersion(p.catalog)));
    if (versions.size > 1) throw new Error(`platforms have different catalog versions: ${[...versions].join(", ")}`);
    return writeRelease({ id, files, manifests: {}, platforms }, sources, releasesDir);
}

function writeRelease(release: Release, sources: Map<string, string>, releasesDir: string): Release {
    const dest = join(releasesDir, release.id);
    const tmp = join(releasesDir, `.tmp-${release.id}-${process.pid}`);
    try {
        rmSync(tmp, { recursive: true, force: true });
        for (const [rel, src] of sources) {
            const to = join(tmp, "files", rel);
            mkdirSync(join(to, ".."), { recursive: true });
            copyFileSync(src, to);
        }
        writeFileSync(join(tmp, "release.json"), JSON.stringify(release));
        renameSync(tmp, dest);
    } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
    }
    return release;
}

/**
 * importRelease from a zip of the export folder (zipped as www/ or as its
 * contents). Extracts into a scratch folder inside releasesDir, removed
 * afterwards whether or not it worked.
 */
export function importReleaseZip(zipPath: string, releasesDir: string, id: string, limits?: ZipLimits): Release {
    if (!isReleaseId(id)) throw new Error(`bad release id ${JSON.stringify(String(id).slice(0, 40))}`);
    if (existsSync(join(releasesDir, id))) throw new Error(`release ${id} already exists`);
    const scratch = join(releasesDir, `.zip-${id}-${process.pid}`);
    try {
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true });
        extractZip(zipPath, scratch, limits);
        const wrapped = join(scratch, "www");
        let src = existsSync(wrapped) && statSync(wrapped).isDirectory() ? wrapped : scratch;
        // A single top-level folder that isn't a platform is a wrapper (zipped as <name>/<Platform>/...).
        const top = readdirSync(src);
        if (top.length === 1 && statSync(join(src, top[0]!)).isDirectory() && !(ADDRESSABLES_PLATFORMS as readonly string[]).includes(top[0]!)
            && readdirSync(join(src, top[0]!)).some((n) => (ADDRESSABLES_PLATFORMS as readonly string[]).includes(n))) src = join(src, top[0]!);
        return importRelease(src, releasesDir, id);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

/** The imported release, or null for an unknown or unsafe id or an unreadable release.json. */
export function loadRelease(releasesDir: string, id: string): Release | null {
    if (!isReleaseId(id)) return null;
    try {
        const r = JSON.parse(readFileSync(join(releasesDir, id, "release.json"), "utf8"));
        return r && r.id === id && r.files && r.manifests ? (r as Release) : null;
    } catch { return null; }
}

/** The stored file for a path the release lists, else null (unknown release, unlisted path, traversal). */
export function releaseFilePath(releasesDir: string, id: string, path: string): string | null {
    const r = loadRelease(releasesDir, id);
    if (!r || !Object.prototype.hasOwnProperty.call(r.files, path)) return null;
    return join(releasesDir, id, "files", path);
}
