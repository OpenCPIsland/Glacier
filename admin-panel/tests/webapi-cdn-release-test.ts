// CDN content releases through the real web API: saving a row that names a
// release (refused when the release doesn't exist), the boot chain naming the
// release's files, serving them byte for byte, and empty 404s for anything
// not listed. Releases are served even while the switch is off.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { importRelease } from "../../web-api/src/services/cdnReleases.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "e".repeat(64);
const PORT = 18691 + (process.pid % 300);
const root = mkdtempSync(join(tmpdir(), "cdn-rel-routes-"));
const releasesDir = join(root, "releases");
const env = {
  ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET,
  WEBAPI_ADMIN_PORT: String(PORT), CDN_RELEASES_DIR: releasesDir,
};
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };
const CV = "83523013bb2d807ac74ac353d58d22876a6fee91";
const row = { client: "1.15.0", platform: "standalonewindows64", contentVersion: CV };

// A Step 4 export tree with one sprite bundle and one manifest bundle for Windows.
const src = join(root, "www");
const put = (rel: string, body: string | Uint8Array) => { const p = join(src, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };
const SPRITE = new Uint8Array([0, 1, 2, 3, 255, 254, 10, 13, 0, 7]);
put("1700000001/ClientBundles/standalonewindows64/aaaa.unity3d", SPRITE);
put("1700000001/ClientBundles/standalonewindows64/mmmm.unity3d", "manifest bundle bytes");
put("1700000001/ClientBundles/standalonewindows64/notes.txt", "not served");
put("1700000002/ClientManifestDirectory.json", JSON.stringify({ directory: [{ client: "1.15.0", platform: "standalonewindows64", url: "ClientBundles/standalonewindows64/mmmm.unity3d" }] }));
mkdirSync(releasesDir, { recursive: true });
importRelease(src, releasesDir, "test-1");

const api = await startWebApi({ env });
const admin = async (method: "GET" | "POST", path: string, body: unknown, actor: Actor, action: string) => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = { "Content-Type": "application/json", ...signHeaders(SECRET, method, path, raw, actor, action) };
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: method === "POST" ? raw : undefined });
      let json: any = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    } catch { await Bun.sleep(100); }
  }
  throw new Error("admin listener never came up");
};
const save = (body: unknown) => admin("POST", "/cdn/save", body, owner, "cdn.edit");
const current = async () => admin("GET", "/cdn", undefined, owner, "cdn.view");
const get = (path: string) => fetch(api.base + path);
const empty404 = async (path: string) => { const r = await get(path); return r.status === 404 && (await r.text()) === ""; };
const BUNDLE = "/cdn.disney.io/test-1/ClientBundles/standalonewindows64/aaaa.unity3d";

try {
  let r = await save({ enabled: false, entries: [{ ...row, release: "nope" }], expectSetAt: null });
  check(r.status === 400 && /release/.test(r.json?.error ?? ""), `a row naming a release that doesn't exist is refused (${r.status} ${r.json?.error})`);
  r = await save({ enabled: false, entries: [{ ...row, release: "../x" }], expectSetAt: null });
  check(r.status === 400, "an unsafe release id is refused");

  r = await save({ enabled: true, entries: [{ ...row, release: "test-1" }], expectSetAt: null });
  check(r.status === 200 && r.json?.config?.entries?.[0]?.release === "test-1", `a row naming an imported release is saved (${r.status})`);

  const mapping: any = await (await get("/__mapping_cpremix_prod.json")).json();
  const manifest: any = await (await get("/" + mapping.default.n)).json();
  check(manifest.paths["ClientBundles/standalonewindows64/aaaa.unity3d"]?.v === "test-1" && manifest.paths["ClientBundles/standalonewindows64/mmmm.unity3d"]?.crc === Bun.hash.crc32("manifest bundle bytes").toString(16).toUpperCase().padStart(8, "0"), "the manifest lists the release's bundles with v = release id and their CRCs");
  const h2 = manifest.paths["ClientManifestDirectory.json"].v;
  const dir: any = await (await get(`/cdn.disney.io/${h2}/ClientManifestDirectory.json`)).json();
  check(dir.directory[0].content === "test-1" && dir.directory[0].useEmbeddedContent === false && dir.directory[0].url === "ClientBundles/standalonewindows64/mmmm.unity3d", "the served directory sends the row to the release's manifest bundle");

  const res = await get(BUNDLE);
  const bytes = new Uint8Array(await res.arrayBuffer());
  check(res.status === 200 && bytes.length === SPRITE.length && bytes.every((b, i) => b === SPRITE[i]), "a release file is served byte for byte");
  check((res.headers.get("cache-control") ?? "").includes("immutable") || (res.headers.get("cache-control") ?? "").includes("max-age"), "release files are cacheable");
  const ranged = await fetch(api.base + BUNDLE, { headers: { Range: "bytes=2-4" } });
  check(ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 3, "ranged downloads work");

  check(await empty404("/cdn.disney.io/test-1/ClientBundles/standalonewindows64/notes.txt"), "a file the release doesn't list is an empty 404");
  check(await empty404("/cdn.disney.io/test-1/ClientBundles/standalonewindows64/zzzz.unity3d"), "an unknown file is an empty 404");
  check(await empty404("/cdn.disney.io/nope/ClientBundles/standalonewindows64/aaaa.unity3d"), "an unknown release is an empty 404");
  check(await empty404("/cdn.disney.io/test-1/ClientBundles/%2e%2e/%2e%2e/release.json") && await empty404("/cdn.disney.io/test-1/ClientBundles/standalonewindows64/%2e%2e%2f%2e%2e%2frelease.json"), "traversal is an empty 404");

  // The directory a client read just before a change is still served after it.
  const before = h2;
  const cur = (await current()).json.config;
  r = await save({ enabled: true, entries: [{ ...row }], expectSetAt: cur.setAt });
  check(r.status === 200 && (await get(`/cdn.disney.io/${before}/ClientManifestDirectory.json`)).status === 200, "the previous directory (with its release row) is still served after the row drops the release");

  const cur2 = (await current()).json.config;
  r = await save({ enabled: false, entries: [{ ...row, release: "test-1" }], expectSetAt: cur2.setAt });
  check(r.status === 200 && (await get(BUNDLE)).status === 200, "release files stay served while the switch is off");
  check(await empty404("/__mapping_cpremix_prod.json"), "…while the mapping is still an empty 404");
} finally {
  await api.stop();
  rmSync(root, { recursive: true, force: true });
}
finish();
