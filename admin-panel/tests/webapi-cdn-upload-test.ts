// web-api admin listener: listing releases (admins) and importing a staged
// zip as a release (owners only). Staged names are the panel's own random
// names, the staged file is always deleted afterwards, and a bad zip leaves
// no release.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { makeZip } from "../../tools/lib/zipmaker.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "f".repeat(64);
const PORT = 18991 + (process.pid % 300);
const root = mkdtempSync(join(tmpdir(), "cdn-upload-"));
const releasesDir = join(root, "releases"), stagingDir = join(root, "staging");
mkdirSync(releasesDir); mkdirSync(stagingDir);
const env = {
  ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET,
  WEBAPI_ADMIN_PORT: String(PORT), CDN_RELEASES_DIR: releasesDir, CDN_STAGING_DIR: stagingDir,
};
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };
const adm: Actor = { email: "adm@x.com", role: "admin", extras: [] };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };

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
const list = (actor = adm) => admin("GET", "/cdn/releases", undefined, actor, "cdn.view");
const imp = (staged: string, id: string, actor = owner) => admin("POST", "/cdn/releases/import", { staged, id }, actor, "cdn.edit");
let counter = 0;
const stage = (bytes: Uint8Array | string) => { const name = (++counter).toString(16).padStart(32, "0") + ".zip"; writeFileSync(join(stagingDir, name), bytes); return name; };

const goodZip = () => makeZip([
  { name: "www/1700000001/ClientBundles/standalonewindows64/aaaa.unity3d", data: "sprite" },
  { name: "www/1700000001/ClientBundles/standalonewindows64/mmmm.unity3d", data: "manifest" },
  { name: "www/1700000002/ClientManifestDirectory.json", data: JSON.stringify({ directory: [{ client: "1.15.0", platform: "standalonewindows64", url: "ClientBundles/standalonewindows64/mmmm.unity3d" }] }) },
]);

try {
  let r = await list();
  check(r.status === 200 && Array.isArray(r.json?.releases) && r.json.releases.length === 0, "no releases to start with");
  check((await list(mod)).status === 403, "a moderator can't list releases");

  for (const staged of ["../x.zip", "abc.zip", "A".repeat(32) + ".zip", "0".repeat(32) + ".zip/../x", "0".repeat(32) + ".txt", "", 5]) {
    r = await admin("POST", "/cdn/releases/import", { staged, id: "up-1" }, owner, "cdn.edit");
    check(r.status === 400, `staged name ${JSON.stringify(staged)} is refused (${r.status})`);
  }
  r = await imp("0".repeat(32) + ".zip", "up-1");
  check(r.status === 404, `a missing staged file is 404 (${r.status})`);
  r = await imp(stage(goodZip()), "../evil");
  check(r.status === 400 && /id/i.test(r.json?.error ?? ""), "an unsafe release id is refused");
  check(readdirSync(stagingDir).length === 1, "…and a refused request still leaves that staged file for a retry");

  const s1 = stage(goodZip());
  r = await imp(s1, "up-1", adm);
  check(r.status === 403 && existsSync(join(stagingDir, s1)), "an admin can't import (owner only), and nothing is deleted");

  r = await imp(s1, "up-1");
  check(r.status === 200 && r.json?.release?.id === "up-1" && r.json.release.bundles === 2 && r.json.release.platforms?.join() === "standalonewindows64", `an owner imports a staged zip (${r.status} ${JSON.stringify(r.json)})`);
  check(!existsSync(join(stagingDir, s1)), "the staged file is deleted after a successful import");
  r = await list();
  check(r.json.releases.length === 1 && r.json.releases[0].id === "up-1" && r.json.releases[0].bundles === 2 && typeof r.json.releases[0].importedAt === "string", "the release is listed");

  const s2 = stage(goodZip());
  r = await imp(s2, "up-1");
  check(r.status === 409 && !existsSync(join(stagingDir, s2)), "a taken id is 409 and the staged file is deleted");
  const s3 = stage(makeZip([{ name: "../evil", data: "x" }]));
  r = await imp(s3, "up-2");
  check(r.status === 400 && !existsSync(join(stagingDir, s3)) && !existsSync(join(releasesDir, "up-2")), "a bad zip is 400, deleted, and leaves no release");
  const s4 = stage("this is not a zip at all, just text");
  r = await imp(s4, "up-3");
  check(r.status === 400 && !existsSync(join(stagingDir, s4)), "a non-zip is 400 and deleted");
  check(readdirSync(releasesDir).filter((n) => !n.startsWith(".")).join() === "up-1" && readdirSync(releasesDir).every((n) => !n.startsWith(".")), "only the good release is on disk, no scratch folders");

  r = await admin("POST", "/cdn/save", { enabled: true, entries: [{ client: "1.15.0", platform: "standalonewindows64", contentVersion: "83523013bb2d807ac74ac353d58d22876a6fee91", release: "up-1" }], expectSetAt: null }, owner, "cdn.edit");
  check(r.status === 200, "an uploaded release can be assigned to a row");
} finally {
  await api.stop();
  rmSync(root, { recursive: true, force: true });
}
finish();
