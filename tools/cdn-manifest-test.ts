// CDN boot files: exact body shapes, hashes, validation, and ports of the
// client's own matching rules (ContentManifestDirectoryEntry.IsEqualTo,
// ClientInfo.ParseClientVersion, CPipeManifestService.getFullAssetUrl).
import { createHash } from "node:crypto";
import { makeChecker } from "./lib/harness.ts";
import {
    buildCdnFiles, validateCdnConfig, parseCdnConfig, cdnVersion, clientVersionEquals, fullAssetUrl,
    OFF, type CdnConfig,
} from "../web-api/src/services/cdnManifest.ts";

const { check, finish } = makeChecker();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const crc32 = (s: string) => Bun.hash.crc32(s).toString(16).toUpperCase().padStart(8, "0");

const CV = "83523013bb2d807ac74ac353d58d22876a6fee91";
const cfg: CdnConfig = {
    enabled: true,
    entries: [
        { client: "1.15.0", platform: "standalonewindows64", contentVersion: CV },
        { client: "1.14.1", platform: "standalonelinux64", contentVersion: CV },
    ],
    setBy: "boss@x.com",
    setAt: "2026-11-11T12:00:00.000Z",
};
const f = buildCdnFiles(cfg, "https://play.example");

const entry = (client: string, platform: string) =>
    `{"client":"${client}","platform":"${platform}","environment":"production","content":"embedded","useEmbeddedContent":true,"url":"","abtest":"","contentVersion":"${CV}","releaseScheduleName":"","releaseDate":"2016-01-01 00:00:00 -08:00","decryptionKey":""}`;
check(f.directory === `{"directory":[${entry("1.14.1", "standalonelinux64")},${entry("1.15.0", "standalonewindows64")}]}`, "exact directory body, sorted");
check(f.h2 === sha(f.directory).slice(0, 16) && /^[0-9a-f]{16}$/.test(f.h2), "h2 is the sha256 prefix of the directory");

const m = JSON.parse(f.manifest);
check(JSON.stringify(m) === JSON.stringify({
    version: f.h1, unique: String(f.v), cdnRoot: "https://play.example/cdn.disney.io", url: "",
    paths: { "ClientManifestDirectory.json": { crc: crc32(f.directory), v: f.h2 } },
}), "exact manifest body and key order");
const blanked = f.manifest.replace(`"version":"${f.h1}"`, '"version":""');
check(blanked !== f.manifest && f.h1 === sha(blanked).slice(0, 16), "h1 is the hash of the manifest with version blanked");
check(f.mapping === `{"default":{"n":"manifests/cpipe.${f.h1}.json","v":${f.v}}}` && f.v === 1794398400, `exact mapping (v ${f.v})`);

const reversed = buildCdnFiles({ ...cfg, entries: [...cfg.entries].reverse() }, "https://play.example");
const again = buildCdnFiles(cfg, "https://play.example");
check(again.manifest === f.manifest && again.mapping === f.mapping && again.directory === f.directory, "same list gives the same bodies");
check(reversed.h1 === f.h1 && reversed.h2 === f.h2 && reversed.directory === f.directory, "entry order doesn't matter");

const changed = buildCdnFiles({ ...cfg, entries: [{ ...cfg.entries[0]!, contentVersion: "a".repeat(40) }, cfg.entries[1]!] }, "https://play.example");
check(changed.h2 !== f.h2 && changed.h1 !== f.h1, "a different contentVersion changes h2 and h1");
const later = buildCdnFiles({ ...cfg, setAt: "2026-11-11T12:00:01.000Z" }, "https://play.example");
check(later.v === f.v + 1 && later.h1 !== f.h1 && later.h2 === f.h2, "a later setAt changes v and h1 but not h2");
check(buildCdnFiles(cfg, "http://other.example").h1 !== f.h1, "the origin is part of h1");

check(m.cdnRoot.endsWith("cdn.disney.io"), "cdnRoot ends in cdn.disney.io");
check(fullAssetUrl(m.cdnRoot, f.h2, "ClientManifestDirectory.json") === `https://play.example/cdn.disney.io/${f.h2}/ClientManifestDirectory.json`, "client builds the directory URL under our host");
check(fullAssetUrl("https://a/x/", "1", "f") === "https://a/x.disney.io/1/f", "getFullAssetUrl appends .disney.io and trims the slash");

check(clientVersionEquals("1.15.0", "1.15.0"), "1.15.0 = 1.15.0");
check(clientVersionEquals("1.015.0", "1.15.0"), "1.015.0 = 1.15.0 (int components)");
check(clientVersionEquals("v1.15.0", "1.15.0"), "a v prefix is stripped");
check(!clientVersionEquals("1.15", "1.15.0"), "1.15 ≠ 1.15.0");
check(!clientVersionEquals("1.15.0", "1.15.0.0"), "1.15.0 ≠ 1.15.0.0");

const row = cfg.entries[0]!;
const bad = (entries: unknown[], enabled = false) => validateCdnConfig({ enabled, entries });
const refuses = (label: string, r: ReturnType<typeof validateCdnConfig>, text: string) =>
    check(!r.ok && r.error.includes(text), `${label} refused (${r.ok ? "accepted" : r.error})`);
for (const client of ["1.15.0-beta", "1", "1.2.3.4.5", "1234567.0", ""]) refuses(`client ${JSON.stringify(client)}`, bad([{ ...row, client }]), "entry 1: bad client");
for (const platform of ["StandaloneWindows64", "windows64"]) refuses(`platform ${platform}`, bad([{ ...row, platform }]), "entry 1: bad platform");
for (const contentVersion of [CV.toUpperCase(), CV.slice(1), ""]) refuses(`contentVersion ${contentVersion.length} chars`, bad([{ ...row, contentVersion }]), "entry 1: bad contentVersion");
refuses("duplicates by parsed version", bad([row, { ...row, client: "1.015.0" }]), "entry 2: duplicate");
refuses("201 entries", bad(Array.from({ length: 201 }, (_, i) => ({ ...row, client: `1.${i}.0` }))), "too many entries (max 200)");
refuses("on with an empty list", bad([], true), "can't turn on with an empty list");
refuses("entries not an array", validateCdnConfig({ enabled: false, entries: "x" }), "entries");
refuses("not an object", validateCdnConfig(5), "object");
refuses("enabled not a boolean", validateCdnConfig({ enabled: "yes", entries: [row] }), "enabled");
refuses("entry not an object", bad([null]), "entry 1");

check(bad([row, { ...row, client: "1.15" }]).ok, "1.15 and 1.15.0 can both be listed");
check(bad(Array.from({ length: 200 }, (_, i) => ({ ...row, client: `1.${i}.0` }))).ok, "200 entries accepted");
check(bad([]).ok, "off with an empty list accepted");
check(bad([{ ...row, client: "1.16.1.1" }]).ok, "a 4-part version accepted");
const sorted = validateCdnConfig({ ...cfg, extra: "dropped" });
check(sorted.ok && sorted.config.entries[0]!.client === "1.14.1" && !("extra" in sorted.config) && sorted.config.setBy === "boss@x.com", "validated copy is sorted and keeps only known fields");

for (const raw of [null, "", "{", "[]", "5", '{"enabled":true,"entries":[]}', JSON.stringify({ ...cfg, entries: [row, { ...row, platform: "nope" }] })]) {
    check(JSON.stringify(parseCdnConfig(raw)) === JSON.stringify(OFF), `parseCdnConfig(${String(raw).slice(0, 24)}) is off`);
}
check(JSON.stringify(parseCdnConfig(JSON.stringify(cfg))) === JSON.stringify({ ...cfg, entries: [cfg.entries[1], cfg.entries[0]] }), "a valid stored config round-trips");
check(cdnVersion(OFF) === 1 && cdnVersion({ ...cfg, setAt: "junk" }) === 1 && cdnVersion({ ...cfg, setAt: "2999-01-01T00:00:00Z" }) === 2147483647, "cdnVersion clamps to 1..2147483647");

// --- Rows that reference a content release ---------------------------------
const REL = { id: "test-1", files: { "ClientBundles/standalonewindows64/aaaa.unity3d": { crc: "0000000A" }, "ClientBundles/standalonewindows64/mmmm.unity3d": { crc: "0000000B" }, "ClientBundles/android/zzzz.unity3d": { crc: "0000000C" } }, manifests: { standalonewindows64: "ClientBundles/standalonewindows64/mmmm.unity3d" } };
const loader = (id: string) => (id === "test-1" ? REL : null);
const relRow = { client: "1.15.0", platform: "standalonewindows64", contentVersion: CV, release: "test-1" };
const withRel: CdnConfig = { ...cfg, entries: [{ client: "1.14.1", platform: "standalonelinux64", contentVersion: CV }, relRow as any] };
const g = buildCdnFiles(withRel, "https://play.example", loader);
const dir = JSON.parse(g.directory).directory;
check(dir[0].content === "embedded" && dir[0].useEmbeddedContent === true && dir[0].url === "", "a row without a release stays embedded");
check(dir[1].content === "test-1" && dir[1].useEmbeddedContent === false && dir[1].url === "ClientBundles/standalonewindows64/mmmm.unity3d" && dir[1].contentVersion === CV, "a release row is downloadable: content is the release id, url its platform's manifest bundle");
check(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/.test(dir[1].releaseDate), "a release row keeps a releaseDate the client can parse");
const gm = JSON.parse(g.manifest);
check(gm.paths["ClientBundles/android/zzzz.unity3d"]?.v === "test-1" && gm.paths["ClientBundles/standalonewindows64/aaaa.unity3d"]?.crc === "0000000A", "every file of a used release is in the manifest's paths, v = the release id");
check(gm.paths["ClientManifestDirectory.json"]?.v === g.h2 && Object.keys(gm.paths).length === 4, "the directory path is still there, nothing else");
check(g.h1 !== buildCdnFiles(cfg, "https://play.example").h1 && g.h2 !== buildCdnFiles(cfg, "https://play.example").h2, "using a release changes both hashes");
const REL2 = { ...REL, files: { ...REL.files, "ClientBundles/android/zzzz.unity3d": { crc: "0000000D" } } };
check(buildCdnFiles(withRel, "https://play.example", (id) => (id === "test-1" ? REL2 : null)).h1 !== g.h1, "a changed file CRC changes h1");

// An Addressables release: catalog-only rows (url "" and content = the release id).
const V2 = { id: "v2", files: { "Android/catalog_1.0.bin": { sha256: "aa", size: 1 }, "Android/a.bundle": { sha256: "bb", size: 2 } }, manifests: {}, platforms: { Android: { catalog: "catalog_1.0.bin", hash: "0".repeat(32) } } };
const v2cfg: CdnConfig = { ...cfg, entries: [{ client: "1.14.1", platform: "android", contentVersion: CV, release: "v2" }, { client: "1.14.1", platform: "standalonelinux64", contentVersion: CV, release: "v2" }] as any };
const v2g = buildCdnFiles(v2cfg, "https://play.example", (id) => (id === "v2" ? V2 : null));
const v2dir = JSON.parse(v2g.directory).directory;
const v2and = v2dir.find((e: any) => e.platform === "android"), v2lin = v2dir.find((e: any) => e.platform === "standalonelinux64");
check(v2and.content === "v2" && v2and.useEmbeddedContent === false && v2and.url === "", "v2: a covered platform is catalog-only: content = release id, url empty, not embedded");
check(v2lin.content === "embedded" && v2lin.useEmbeddedContent === true, "v2: a platform the release lacks stays embedded");
check(Object.keys(JSON.parse(v2g.manifest).paths).join() === "ClientManifestDirectory.json", "v2: release files are not listed in the cpipe manifest");
check(v2g.h2 !== buildCdnFiles(v2cfg, "https://play.example").h2, "v2: using a release changes the directory hash");

const none = buildCdnFiles(withRel, "https://play.example", () => null);
check(JSON.parse(none.directory).directory.every((e: any) => e.content === "embedded" && e.url === ""), "a release that can't be loaded falls back to embedded instead of breaking boot");
check(Object.keys(JSON.parse(none.manifest).paths).join() === "ClientManifestDirectory.json", "…and adds no paths");
const noPlat = buildCdnFiles({ ...withRel, entries: [{ ...relRow, platform: "android" } as any] }, "https://play.example", loader);
check(JSON.parse(noPlat.directory).directory[0].content === "embedded", "a release without a manifest bundle for the row's platform falls back to embedded");
check(buildCdnFiles(withRel, "https://play.example").directory === none.directory, "no loader is the same as none loadable");

const rv = validateCdnConfig({ enabled: true, entries: [relRow] });
check(rv.ok && (rv.config.entries[0] as any).release === "test-1", "a valid release id is kept");
for (const release of ["../x", "a/b", "", "x".repeat(41), 5]) refuses(`release ${JSON.stringify(release)}`, validateCdnConfig({ enabled: false, entries: [{ ...relRow, release }] }), "entry 1: bad release");
const plain = validateCdnConfig({ enabled: true, entries: [row] });
check(plain.ok && !("release" in plain.config.entries[0]!), "a row without a release gets no release key");

finish();
