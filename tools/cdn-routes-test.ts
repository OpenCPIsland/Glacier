// The three CDN boot-file routes on a throwaway web API: 404 while off or
// when the stored value is bad, the mapping → manifest → directory chain
// while on, per-host and per-publish names, and the client's matching rules.
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeChecker, startWebApi } from "./lib/harness.ts";
import { importRelease } from "../web-api/src/services/cdnReleases.ts";
import { buildCdnFiles, clientVersionEquals, fullAssetUrl, type CdnConfig } from "../web-api/src/services/cdnManifest.ts";

const { check, finish } = makeChecker();
const CV = "83523013bb2d807ac74ac353d58d22876a6fee91";
const rows = [
    { client: "1.14.1", platform: "standalonelinux64", contentVersion: CV },
    { client: "1.15.0", platform: "standalonewindows64", contentVersion: CV },
] as const;
const cfg = (over: Partial<CdnConfig> = {}): CdnConfig => ({ enabled: true, entries: [...rows], setBy: "t@x.com", setAt: "2026-11-11T12:00:00.000Z", ...over });

// Two releases on disk before the server starts: an Addressables one and a legacy one.
const scratch = mkdtempSync(join(tmpdir(), "cdn-routes-"));
const releases = join(scratch, "releases");
mkdirSync(releases);
const put = (dir: string, rel: string, body: string) => { const p = join(dir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
const HASH = "0123456789abcdef0123456789abcdef";
const addr = join(scratch, "addr");
put(addr, "Android/catalog_1.17.0.hash", HASH);
put(addr, "Android/catalog_1.17.0.bin", "CATALOG-BYTES");
put(addr, "Android/a.bundle", "0123456789");
importRelease(addr, releases, "v2");
const legacy = join(scratch, "legacy");
put(legacy, "1/ClientBundles/android/bbbb.unity3d", "legacy bundle");
put(legacy, "1/ClientBundles/android/nnnn.unity3d", "legacy manifest");
put(legacy, "2/ClientManifestDirectory.json", JSON.stringify({ directory: [{ client: "1.0", platform: "android", url: "ClientBundles/android/nnnn.unity3d" }] }));
importRelease(legacy, releases, "old");

const api = await startWebApi({ env: { CDN_RELEASES_DIR: releases } });
const setCfg = (v: unknown) => {
    const db = new Database(api.dbPath);
    db.run("INSERT INTO settings (key, value, updated_at) VALUES ('cdn_config', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [typeof v === "string" ? v : JSON.stringify(v)]);
    db.close();
};
const get = (path: string, headers: Record<string, string> = {}) => fetch(api.base + path, { headers });
const FAKE_H = "0123456789abcdef";
// The client caches whatever body a CDN path returns, so a 404 must carry none.
const empty404 = async (path: string, headers: Record<string, string> = {}) => { const r = await get(path, headers); return r.status === 404 && (await r.text()) === ""; };

try {
    check(await empty404("/__mapping_cpremix_prod.json"), "off by default: mapping 404 with an empty body");
    check(await empty404(`/manifests/cpipe.${FAKE_H}.json`) && await empty404(`/cdn.disney.io/${FAKE_H}/ClientManifestDirectory.json`), "off by default: manifest and directory 404 with empty bodies");

    for (const [label, v] of [["broken JSON", "{"], ["on with no entries", { enabled: true, entries: [] }], ["a bad row", cfg({ entries: [{ ...rows[0], contentVersion: "nope" }] })]] as const) {
        setCfg(v);
        check(await empty404("/__mapping_cpremix_prod.json"), `garbage setting (${label}) → empty 404`);
    }

    setCfg(cfg());
    let r = await get("/__mapping_cpremix_prod.json?access_token=x&cacheBust=y");
    const mapping: any = await r.json();
    check(r.status === 200 && r.headers.get("cache-control")?.includes("no-store") === true && /^manifests\/cpipe\.[0-9a-f]{16}\.json$/.test(mapping.default?.n) && Number.isInteger(mapping.default?.v), "on: mapping 200, no-store, names a manifest");
    r = await get("/" + mapping.default.n);
    const manifestText = await r.text();
    const manifest = JSON.parse(manifestText);
    check(r.status === 200 && r.headers.get("cache-control")?.includes("max-age=300") === true, "manifest 200 with max-age=300");
    const dirUrl = fullAssetUrl(manifest.cdnRoot, manifest.paths["ClientManifestDirectory.json"].v, "ClientManifestDirectory.json");
    r = await get(new URL(dirUrl).pathname);
    const dirText = await r.text();
    const crc = Bun.hash.crc32(dirText).toString(16).toUpperCase().padStart(8, "0");
    check(r.status === 200 && crc === manifest.paths["ClientManifestDirectory.json"].crc, "directory resolves from the manifest and its CRC matches");

    const want = buildCdnFiles(cfg(), api.base);
    check(JSON.stringify(mapping) === want.mapping && manifestText === want.manifest && dirText === want.directory, "served bodies are byte-equal to the generator");

    const dir: any = JSON.parse(dirText);
    const findEntry = (client: string, platform: string) => dir.directory.find((e: any) => clientVersionEquals(e.client, client) && e.platform === platform && e.environment === "production");
    for (const row of rows) {
        const e = findEntry(row.client, row.platform);
        check(!!e && e.content === "embedded" && e.useEmbeddedContent === true && e.contentVersion === row.contentVersion, `client finds ${row.client} ${row.platform} as embedded with its contentVersion`);
    }
    check(!findEntry("1.13.0", "standalonewindows64") && !findEntry("1.15.0", "standalonelinux64"), "unlisted builds find nothing");

    const old = { h1: mapping.default.n, h2: manifest.paths["ClientManifestDirectory.json"].v };
    setCfg(cfg({ entries: [{ ...rows[0], contentVersion: "a".repeat(40) }, rows[1]], setAt: "2026-11-11T13:00:00.000Z" }));
    const mapping2: any = await (await get("/__mapping_cpremix_prod.json")).json();
    check(await empty404("/" + old.h1) && await empty404(`/cdn.disney.io/${old.h2}/ClientManifestDirectory.json`), "old manifest and directory names (not published through the admin) → empty 404");
    check(mapping2.default.n !== old.h1 && (await get("/" + mapping2.default.n)).status === 200, "the new names are served");

    const other = await (await get("/__mapping_cpremix_prod.json", { Host: "other.example" })).json() as any;
    check(other.default?.n !== mapping2.default.n, "H1 is per host");
    check((await get("/" + mapping2.default.n, { Host: "other.example" })).status === 404, "another host's request for this host's H1 → 404");
    check((await get("/" + other.default.n, { Host: "other.example" })).status === 200, "the other host's own H1 → 200");

    check((await get("/__mapping_cpremix_prod.json", { Authorization: "Basic " + btoa("nobody:wrong") })).status === 200, "stale or bad Basic credentials don't turn the CDN into a 401");

    // Addressables release files: /cdn.disney.io/<release>/<Platform>/<file>
    r = await get("/cdn.disney.io/v2/Android/catalog_1.17.0.hash");
    check(r.status === 200 && (await r.text()) === HASH && r.headers.get("cache-control")?.includes("immutable") === true, "v2: hash file served, immutable");
    r = await get("/cdn.disney.io/v2/Android/catalog_1.17.0.bin");
    check(r.status === 200 && (await r.text()) === "CATALOG-BYTES", "v2: catalog bytes served");
    r = await get("/cdn.disney.io/v2/Android/a.bundle", { Range: "bytes=2-5" });
    check(r.status === 206 && (await r.text()) === "2345", "v2: ranged download gives 206 with that slice");
    for (const path of ["/cdn.disney.io/v2/Android/secret.txt", "/cdn.disney.io/nope/Android/a.bundle", "/cdn.disney.io/v2/Linux/a.bundle", "/cdn.disney.io/v2/Android/..%2F..%2Frelease.json", "/cdn.disney.io/v2/Android/release.json", "/cdn.disney.io/v2/ClientManifestDirectory.json"]) {
        check(await empty404(path), `v2: ${path} → empty 404`);
    }
    r = await get("/cdn.disney.io/v2/Android/a.bundle", { Range: "bytes=50-60" });
    check(r.status === 416 && !(r.headers.get("cache-control") ?? "").includes("immutable"), "v2: an unsatisfiable range is 416, never cached as immutable");
    rmSync(join(releases, "v2", "files", "Android", "a.bundle"));
    r = await get("/cdn.disney.io/v2/Android/a.bundle");
    check(r.status === 404 && (await r.text()) === "" && !(r.headers.get("cache-control") ?? "").includes("immutable") && !r.headers.get("content-range"), "v2: a listed file missing on disk is an empty 404 with no immutable cache header");
    r = await get("/cdn.disney.io/old/ClientBundles/android/bbbb.unity3d");
    check(r.status === 200 && (await r.text()) === "legacy bundle", "legacy layout still served");

    setCfg(cfg({ enabled: false }));
    check(await empty404("/__mapping_cpremix_prod.json") && await empty404("/" + mapping2.default.n), "off again: empty 404 with the list kept");
} finally {
    await api.stop();
    rmSync(scratch, { recursive: true, force: true });
}
finish(api.logs());
