// web-api admin listener: GET/POST /cdn (signed, owner-only edits, dry run,
// stale-edit refusal, validation) and its effect on the public routes.
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { buildCdnFiles } from "../../web-api/src/services/cdnManifest.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "d".repeat(64);
const PORT = 18391 + (process.pid % 300);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(PORT) };
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };
const adm: Actor = { email: "adm@x.com", role: "admin", extras: [] };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };
const CV = "83523013bb2d807ac74ac353d58d22876a6fee91";
const row = { client: "1.15.0", platform: "standalonewindows64", contentVersion: CV };

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
const view = (actor = adm) => admin("GET", "/cdn", undefined, actor, "cdn.view");
const save = (body: unknown, actor = owner) => admin("POST", "/cdn/save", body, actor, "cdn.edit");
const dirPath = (h2: string) => `/cdn.disney.io/${h2}/ClientManifestDirectory.json`;
const getDir = async (h2: string) => { const r = await fetch(api.base + dirPath(h2)); return { status: r.status, text: await r.text() }; };
const publishedH2 = async () => {
  const m: any = await (await fetch(`${api.base}/__mapping_cpremix_prod.json`)).json();
  const manifest: any = await (await fetch(`${api.base}/${m.default.n}`)).json();
  return manifest.paths["ClientManifestDirectory.json"].v as string;
};
const mappingStatus = async () => (await fetch(`${api.base}/__mapping_cpremix_prod.json`)).status;

try {
  let r = await view();
  check(r.status === 200 && r.json?.config?.enabled === false && r.json.config.entries.length === 0, `GET /cdn (admin) → off and empty (${JSON.stringify(r.json)})`);
  check((await fetch(`http://127.0.0.1:${PORT}/cdn`)).status === 401, "unsigned → 401");
  check((await admin("GET", "/cdn", undefined, adm, "dashboard.view")).status === 403, "signed for another action → 403");
  check((await view(mod)).status === 403, "a moderator can't view");
  check((await admin("POST", "/cdn/save", { enabled: false, entries: [], expectSetAt: null }, adm, "cdn.edit")).status === 403, "an admin can't edit");

  r = await save({ enabled: true, entries: [row], expectSetAt: null, dryRun: true });
  check(r.status === 200 && r.json?.config?.enabled === true, "dry run → 200 with the validated config");
  check((await view()).json.config.enabled === false && (await mappingStatus()) === 404, "dry run saved nothing");

  r = await save({ enabled: true, entries: [row], expectSetAt: null });
  const setAt = r.json?.config?.setAt;
  check(r.status === 200 && r.json.config.setBy === "owner@x.com" && typeof setAt === "string", "save → 200 with setBy and setAt");
  check((await mappingStatus()) === 200, "the public mapping is served once on");
  check(api.logs().includes("[CDN] config set enabled=true entries=1 by owner@x.com"), "the change is logged");
  check(JSON.stringify((await view()).json.config.entries) === JSON.stringify([row]), "GET shows the saved list");
  const firstH2 = await publishedH2();
  const firstDir = await getDir(firstH2);
  check(firstDir.status === 200, "the published directory is served");

  r = await save({ enabled: true, entries: [row], expectSetAt: null });
  check(r.status === 409 && r.json?.error === "stale", "a stale expectSetAt → 409");
  r = await save({ enabled: true, entries: [], expectSetAt: setAt });
  check(r.status === 400 && r.json?.error === "can't turn on with an empty list", "on with an empty list → 400");
  r = await save({ enabled: false, entries: [{ ...row, platform: "nope" }], expectSetAt: setAt });
  check(r.status === 400 && String(r.json?.error).includes("entry 1"), "a bad row → 400 naming it");
  check((await view()).json.config.setAt === setAt, "refused edits changed nothing");

  r = await save({ enabled: false, entries: [row], expectSetAt: setAt });
  check(r.status === 200 && (await mappingStatus()) === 404, "turning it off → mapping 404 again");
  check((await view()).json.config.entries.length === 1, "the list is kept while off");

  // A client mid-boot has already read the manifest; a 404 for its directory
  // would be cached by the client as a broken directory and force an upgrade.
  const stillThere = await getDir(firstH2);
  check(stillThere.status === 200 && stillThere.text === firstDir.text, "a published directory is still served while the CDN is off");
  const unknown = await getDir("0123456789abcdef");
  check(unknown.status === 404 && unknown.text === "", "an unknown directory hash → 404 with an empty body");

  let at = (await view()).json.config.setAt;
  let lastH2 = "";
  for (let i = 0; i < 22; i++) {
    const entries = [{ ...row, contentVersion: i.toString(16).padStart(40, "a") }];
    r = await save({ enabled: false, entries, expectSetAt: at });
    at = r.json.config.setAt;
    lastH2 = buildCdnFiles({ enabled: false, entries }, "").h2;
  }
  check((await getDir(lastH2)).status === 200, "the newest published directory is served");
  check((await getDir(firstH2)).status === 404, "history is capped: the oldest directory is dropped after 22 more publishes");
} finally {
  await api.stop();
}
finish(api.logs());
