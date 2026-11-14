// web-api admin listener (preloaded): signed loopback routes for health,
// player lookup, locked role changes and unlocking.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "d".repeat(64);
const PORT = 18091 + (process.pid % 300);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(PORT) };
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };

const api = await startWebApi({ env });
const admin = async (method: "GET" | "POST", path: string, body?: unknown, actor = owner, action = "role.sync", extra: Record<string, string> = {}) => {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "Content-Type": "application/json", ...signHeaders(SECRET, method, path, raw, actor, action), ...extra };
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: method === "POST" ? raw : undefined });
      let json: any = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json };
    } catch { await Bun.sleep(100); } // listener still starting
  }
  throw new Error("admin listener never came up");
};
const usernameOf = (swid: string) => {
  const db = new Database(api.dbPath, { readonly: true });
  const row = db.query("SELECT username FROM player_identity WHERE swid = ?").get(swid) as { username: string };
  db.close();
  return row.username;
};
const internal = (path: string, body: unknown) => fetch(`${api.base}/api/internal/${path}`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify(body) });

try {
  let r = await admin("GET", "/health", undefined, mod, "dashboard.view");
  check(r.status === 200 && r.json?.ok === true, "signed /health → 200");
  const unsigned = await fetch(`http://127.0.0.1:${PORT}/health`);
  check(unsigned.status === 401, `unsigned /health → 401 (${unsigned.status})`);
  r = await admin("GET", "/health", undefined, mod, "dashboard.view", { "X-Forwarded-For": "10.0.0.1" });
  check(r.status === 403, `a proxied request (X-Forwarded-For) is refused (${r.status})`);
  check((await admin("GET", "/nope", undefined, owner, "dashboard.view")).status === 404, "unknown route → 404");

  await createPlayer(api.base, api.dbPath, "{carol}", "Carol");
  await createPlayer(api.base, api.dbPath, "{root}", "Root");
  const carol = usernameOf("{carol}"), root = usernameOf("{root}");

  r = await admin("POST", "/player/resolve", { query: carol.toUpperCase() }, owner, "staff.view");
  check(r.status === 200 && r.json?.username === carol && r.json?.swid === "{carol}" && r.json?.role === "player", `resolve by username, any case (${JSON.stringify(r.json)})`);
  r = await admin("POST", "/player/resolve", { query: "{carol}" }, owner, "staff.view");
  check(r.status === 200 && r.json?.username === carol, "resolve by SWID");
  check((await admin("POST", "/player/resolve", { query: "nobody-here" }, owner, "staff.view")).status === 404, "unknown player → 404");
  check((await admin("POST", "/player/resolve", { query: 5 }, owner, "staff.view")).status === 400, "non-string query → 400");

  r = await admin("POST", "/role", { username: carol.toLowerCase(), role: "moderator" });
  check(r.status === 200 && r.json?.username === carol && r.json?.role === "moderator", `/role sets moderator (${JSON.stringify(r.json)})`);
  const id = await (await internal("identity", { swid: "{carol}" })).json() as any;
  check(id.role === "moderator", "identity reflects the new role");
  check(!(await internal("set-role", { username: carol, role: "admin" })).ok, "in-game set-role on the locked account is refused");
  check((await admin("POST", "/role", { username: carol, role: "owner" })).status === 400, "unknown game role → 400");
  check((await admin("POST", "/role", { username: "ghost", role: "admin" })).status === 404, "unknown username → 404");
  check((await admin("POST", "/role", { username: carol, role: "admin" }, mod, "role.sync")).status === 403, "moderator-signed /role → 403");
  r = await admin("POST", "/role", { username: carol, role: "admin" }, mod, "dashboard.view");
  check(r.status === 403, `a call signed for another action (dashboard.view) can't use /role (${r.status})`);

  r = await admin("POST", "/role/unlock", { username: carol });
  check(r.status === 200, "/role/unlock → 200");
  check((await internal("set-role", { username: carol, role: "player" })).ok, "after unlock, in-game set-role works");

  const big = JSON.stringify({ username: "x".repeat(70 * 1024), role: "admin" });
  check((await admin("POST", "/role", big)).status === 413, "70 KB body → 413");
  check((await admin("POST", "/role", "{not json")).status === 400, "bad JSON → 400");

  await api.restart({ ...env, STAFF_ADMINS: root });
  r = await admin("POST", "/role", { username: root, role: "moderator" });
  check(r.status === 409 && r.json?.error === "config admin", `STAFF_ADMINS account → 409 (${r.status})`);
  r = await admin("POST", "/player/resolve", { query: root }, owner, "staff.view");
  check(r.json?.configAdmin === true && r.json?.role === "admin", `resolve flags a STAFF_ADMINS account (${JSON.stringify(r.json)})`);
  r = await admin("POST", "/player/resolve", { query: carol }, owner, "staff.view");
  check(r.json?.configAdmin === false, "resolve: an ordinary account is not configAdmin");
} finally {
  await api.stop();
}
finish(api.logs());
