// CDN content releases: importing the generator's Export/www tree
// (CreateAssetBundles Step 4) into a release folder, and finding files in
// it safely. A release is immutable once imported.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeChecker } from "./lib/harness.ts";
import { importRelease, loadRelease, releaseFilePath, isReleaseId } from "../web-api/src/services/cdnReleases.ts";

const { check, finish } = makeChecker();
const crc32 = (b: Uint8Array | string) => Bun.hash.crc32(b).toString(16).toUpperCase().padStart(8, "0");
const root = mkdtempSync(join(tmpdir(), "cdn-release-"));
const put = (dir: string, rel: string, body: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
};

// What Step 4 leaves: www/<Todaysdate1>/ClientBundles/<platform>/*.unity3d,
// www/<Todaysdate2>/ClientManifestDirectory.json, www/manifests/__manifest_*.json
function fakeExport(dir: string, over: { skipBundle?: boolean; badPlatform?: boolean } = {}) {
    const d1 = "1794398400", d2 = "1794398401";
    put(dir, `${d1}/ClientBundles/standalonelinux/aaaa.unity3d`, "linux sprite bundle");
    put(dir, `${d1}/ClientBundles/standalonelinux/mmmm.unity3d`, "linux manifest bundle");
    put(dir, `${d1}/ClientBundles/android/bbbb.unity3d`, "android sprite bundle");
    if (!over.skipBundle) put(dir, `${d1}/ClientBundles/android/nnnn.unity3d`, "android manifest bundle");
    put(dir, `${d1}/ClientBundles/android/readme.txt`, "not a bundle");
    put(dir, `manifests/__manifest_cpremix_prod.0000.json`, "{}");
    const entry = (platform: string, urlPlatform: string, hex: string) => ({
        client: "1.17.0", platform, environment: "production", content: "x", useEmbeddedContent: false,
        url: `ClientBundles/${urlPlatform}/${hex}.unity3d`, abtest: "", contentVersion: "c", releaseScheduleName: "", releaseDate: "", decryptionKey: "",
    });
    put(dir, `${d2}/ClientManifestDirectory.json`, JSON.stringify({
        directory: [entry("standalonelinux64", "standalonelinux", "mmmm"), entry(over.badPlatform ? "amiga" : "android", "android", "nnnn")],
    }));
}

try {
    check(isReleaseId("test-1") && isReleaseId("20261111.a") && !isReleaseId("") && !isReleaseId("../x") && !isReleaseId("a/b") && !isReleaseId("x".repeat(41)), "release ids: short, safe characters only");

    const src = join(root, "www"), releases = join(root, "releases");
    fakeExport(src);
    const rel = importRelease(src, releases, "test-1");
    check(rel.id === "test-1", "import returns the release");
    check(Object.keys(rel.files).sort().join() === "ClientBundles/android/bbbb.unity3d,ClientBundles/android/nnnn.unity3d,ClientBundles/standalonelinux/aaaa.unity3d,ClientBundles/standalonelinux/mmmm.unity3d", "only .unity3d files under ClientBundles are listed, paths relative to it");
    check(rel.files["ClientBundles/android/bbbb.unity3d"]?.crc === crc32("android sprite bundle"), "each file's CRC32 is uppercase hex of its bytes");
    check(rel.manifests["standalonelinux64"] === "ClientBundles/standalonelinux/mmmm.unity3d" && rel.manifests["android"] === "ClientBundles/android/nnnn.unity3d", "the manifest bundle per platform comes from ClientManifestDirectory.json");

    const p = releaseFilePath(releases, "test-1", "ClientBundles/android/bbbb.unity3d");
    check(p !== null && existsSync(p) && readFileSync(p, "utf8") === "android sprite bundle", "a listed file resolves to its stored bytes");
    check(releaseFilePath(releases, "test-1", "ClientBundles/android/readme.txt") === null, "an unlisted file is not served");
    check(releaseFilePath(releases, "test-1", "../release.json") === null && releaseFilePath(releases, "test-1", "ClientBundles/../../release.json") === null, "traversal gives nothing");
    check(releaseFilePath(releases, "../test-1", "x") === null && releaseFilePath(releases, "nope", "x") === null, "bad or unknown release id gives nothing");

    const again = loadRelease(releases, "test-1");
    check(JSON.stringify(again) === JSON.stringify(rel), "loadRelease returns what was imported");
    check(loadRelease(releases, "nope") === null && loadRelease(releases, "../x") === null, "unknown or unsafe id loads as null");

    let threw = "";
    try { importRelease(src, releases, "test-1"); } catch (e) { threw = String(e); }
    check(/exists/i.test(threw), "a release id can't be imported twice");

    const bad1 = join(root, "bad1"); fakeExport(bad1, { skipBundle: true });
    threw = ""; try { importRelease(bad1, releases, "bad-1"); } catch (e) { threw = String(e); }
    check(/nnnn/.test(threw) && !existsSync(join(releases, "bad-1")), "a manifest bundle missing from the tree is refused and leaves nothing behind");
    const bad2 = join(root, "bad2"); fakeExport(bad2, { badPlatform: true });
    threw = ""; try { importRelease(bad2, releases, "bad-2"); } catch (e) { threw = String(e); }
    check(/amiga/.test(threw) && !existsSync(join(releases, "bad-2")), "an unknown platform is refused");
    threw = ""; try { importRelease(join(root, "empty"), releases, "bad-3"); } catch (e) { threw = String(e); }
    check(threw !== "", "a folder with no export tree is refused");
    threw = ""; try { importRelease(src, releases, "../evil"); } catch (e) { threw = String(e); }
    check(/id/i.test(threw), "an unsafe id is refused");

    // The command-line wrapper.
    const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "cdn-import-release.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
    const cliReleases = join(root, "cli-releases");
    let out = cli(src, "cli-1", cliReleases);
    const text = out.stdout.toString();
    check(out.exitCode === 0 && /cli-1/.test(text) && /4 bundle/.test(text) && /standalonelinux64/.test(text) && /android/.test(text), "the CLI imports and prints the release, its bundle count and platforms");
    check(loadRelease(cliReleases, "cli-1")?.id === "cli-1", "the CLI's release is loadable");
    out = cli(src, "cli-1", cliReleases);
    check(out.exitCode !== 0 && /exists/.test(out.stderr.toString()), "the CLI fails with a message when the release exists");
    check(cli().exitCode !== 0 && /usage/i.test(cli().stderr.toString()), "the CLI prints usage with no arguments");

    // Addressables update layout: <Platform>/catalog_<v>.bin|json, .hash, .bundle files.
    const HASH = "0123456789abcdef0123456789abcdef";
    function fakeAddr(dir: string, over: { extraCatalog?: boolean; noHash?: boolean; hash?: string; folder?: string; fileName?: string; stray?: boolean; noCatalog?: boolean } = {}) {
        for (const plat of ["StandaloneLinux64", "Android"]) {
            const f = plat === "Android" && over.folder ? over.folder : plat;
            if (!over.noCatalog) put(dir, `${f}/catalog_1.17.0.bin`, `catalog ${plat}`);
            if (!over.noHash && !over.noCatalog) put(dir, `${f}/catalog_1.17.0.hash`, (over.hash ?? HASH) + "\n");
            put(dir, `${f}/${over.fileName ?? "a.bundle"}`, `bundle ${plat}`);
            if (over.extraCatalog && plat === "Android") put(dir, `${f}/catalog_1.18.0.bin`, "second");
            if (over.stray && plat === "Android") put(dir, `${f}/readme.txt`, "x");
        }
    }
    const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
    const v2src = join(root, "v2src");
    fakeAddr(v2src);
    const v2 = importRelease(v2src, releases, "v2");
    check(v2.platforms?.Android?.catalog === "catalog_1.17.0.bin", "v2: platform record names the catalog file");
    check(v2.platforms?.StandaloneLinux64?.hash === HASH, "v2: hash is the trimmed 32 hex");
    check(v2.files["Android/a.bundle"]?.sha256 === sha("bundle Android") && v2.files["Android/a.bundle"]?.size === "bundle Android".length, "v2: files carry SHA-256 and size");
    check(Object.keys(v2.manifests).length === 0, "v2: no manifest bundles");
    const vp = releaseFilePath(releases, "v2", "Android/a.bundle");
    check(vp !== null && readFileSync(vp, "utf8") === "bundle Android", "v2: a listed file resolves");
    check(releaseFilePath(releases, "v2", "Android/x.txt") === null && releaseFilePath(releases, "v2", "Android/../../release.json") === null, "v2: unlisted and traversal give nothing");
    check(loadRelease(releases, "v2")?.platforms?.Android?.hash === HASH, "v2: loadRelease round-trips platforms");
    const cliV2 = cli(v2src, "cli-2", cliReleases);
    check(cliV2.exitCode === 0 && /StandaloneLinux64.*catalog_1\.17\.0\.bin/.test(cliV2.stdout.toString()) && /Android.*catalog_1\.17\.0\.bin/.test(cliV2.stdout.toString()), "the CLI imports an Addressables folder and prints each platform's catalog");


    const refused = (name: string, over: Parameters<typeof fakeAddr>[1], re: RegExp, label: string) => {
        const d = join(root, name); fakeAddr(d, over);
        let t = ""; try { importRelease(d, releases, name); } catch (e) { t = String(e); }
        check(re.test(t) && !existsSync(join(releases, name)) && !readdirSync(releases).some((n) => n.startsWith(".tmp-")), `v2 refused: ${label}`);
    };
    refused("r1", { extraCatalog: true }, /catalog/i, "two catalogs in one folder");
    refused("r2", { noHash: true }, /hash/i, "catalog without hash");
    refused("r3", { hash: "zz" }, /hash/i, "hash isn't 32 hex");
    refused("r4", { folder: "iOS" }, /iOS/, "unsupported platform folder");
    refused("r5", { fileName: "a b.bundle" }, /a b\.bundle/, "unsafe file name");
    refused("r6", { stray: true }, /readme\.txt/, "stray file");
    {
        const d = join(root, "r8"); fakeAddr(d);
        put(d, "Android/catalog_1.16.0.bin", "old"); put(d, "Android/catalog_1.16.0.hash", HASH); rmSync(join(d, "Android/catalog_1.17.0.bin")); rmSync(join(d, "Android/catalog_1.17.0.hash"));
        let t = ""; try { importRelease(d, releases, "r8"); } catch (e) { t = String(e); }
        check(/version/i.test(t) && !existsSync(join(releases, "r8")), "v2 refused: platforms with different catalog versions");
    }
    refused("r7", { noCatalog: true }, /catalog/i, "folder with no catalog");

    // Saving a config: a row may only name a release that covers its platform.
    process.env.ICEBERG_DB_PATH = join(root, "save-check.db");
    process.env.CDN_RELEASES_DIR = releases;
    const { validateCdnConfigWithReleases } = await import("../web-api/src/services/cdnConfig.ts");
    const CVER = "a".repeat(40);
    const row = (platform: string, release: string) => ({ client: "1.17.0", platform, contentVersion: CVER, release });
    const okAndroid = validateCdnConfigWithReleases({ enabled: false, entries: [row("android", "v2")] });
    check(okAndroid.ok, "save: an Android row may use a release with an Android folder");
    const noWin = validateCdnConfigWithReleases({ enabled: false, entries: [row("standalonewindows64", "v2")] });
    check(!noWin.ok && /standalonewindows64/.test((noWin as any).error), "save: a Windows row naming that release is refused, naming the platform");
    check(validateCdnConfigWithReleases({ enabled: false, entries: [row("standalonelinux64", "v2")] }).ok, "save: Linux row accepted (StandaloneLinux64 folder)");
    const wrongVer = validateCdnConfigWithReleases({ enabled: false, entries: [{ ...row("android", "v2"), client: "1.16.1.1" }] });
    check(!wrongVer.ok && /1\.16\.1\.1/.test((wrongVer as any).error) && /1\.17\.0/.test((wrongVer as any).error), "save: a row whose client version differs from the release's catalog version is refused, naming both");
    check(validateCdnConfigWithReleases({ enabled: false, entries: [{ ...row("android", "v2"), client: "1.017.0" }] }).ok, "save: client versions compare as the client does (1.017.0 = 1.17.0)");
    check(!validateCdnConfigWithReleases({ enabled: false, entries: [row("android", "missing")] }).ok, "save: unknown release refused");
    check(validateCdnConfigWithReleases({ enabled: false, entries: [row("android", "test-1")] }).ok, "save: a legacy release still covers its manifest platforms");
} finally {
    rmSync(root, { recursive: true, force: true });
}
finish();
