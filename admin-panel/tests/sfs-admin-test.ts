// Game-server admin listener (preloaded): online count and pushing a role
// to live sessions without a relog.
import { resolve } from "node:path";
import { makeChecker } from "../../tools/lib/harness.ts";
import { startServers, Client, sleep } from "../../tools/lib/staff-client.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "e".repeat(64);
const PORT = 18392 + (process.pid % 300);
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };

const servers = await startServers({ sfsEnv: { BUN_OPTIONS: `--preload=${REPO}/smartfox-server/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, SFS_ADMIN_PORT: String(PORT) } });
const admin = async (method: "GET" | "POST", path: string, body: unknown, actor: Actor, action: string) => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "Content-Type": "application/json", ...signHeaders(SECRET, method, path, raw, actor, action) }, body: method === "POST" ? raw : undefined });
      return { status: res.status, json: await res.json().catch(() => null) as any };
    } catch { await sleep(100); }
  }
  throw new Error("game-server admin listener never came up");
};
const say = async (c: Client, msg: string) => { c.bubbles = []; await c.chat(msg); await sleep(300); return c.bubbles.join("\n"); };

try {
  let r = await admin("GET", "/health", undefined, mod, "dashboard.view");
  check(r.status === 200 && r.json?.ok === true && r.json?.online === 0, `health with nobody online (${JSON.stringify(r.json)})`);
  const unsigned = await fetch(`http://127.0.0.1:${PORT}/health`);
  check(unsigned.status === 401, "unsigned → 401");
  check((await admin("POST", "/session-role", { username: "x", role: "admin" }, mod, "dashboard.view")).status === 403, "a call signed for another action can't use /session-role");

  const alice = new Client(servers, "{sa-alice}", "AdmAlice");
  await alice.connect();
  r = await admin("GET", "/health", undefined, mod, "dashboard.view");
  check(r.json?.online === 1, `online count is 1 after a login (${r.json?.online})`);

  const before = await say(alice, ":help");
  check(!before.includes(":kick"), "a player's :help has no moderator commands");
  r = await admin("POST", "/session-role", { username: alice.username.toUpperCase(), role: "moderator" }, owner, "role.sync");
  check(r.status === 200 && r.json?.updated === 0, `a username differing only in case is another account: not updated (${JSON.stringify(r.json)})`);
  r = await admin("POST", "/session-role", { username: alice.username, role: "moderator" }, owner, "role.sync");
  check(r.status === 200 && r.json?.updated === 1, `/session-role updates the live session by exact username (${JSON.stringify(r.json)})`);
  const after = await say(alice, ":help");
  check(after.includes(":kick"), "after /session-role, :help lists moderator commands without a relog");
  check((await admin("POST", "/session-role", { username: alice.username, role: "owner" }, owner, "role.sync")).status === 400, "unknown game role → 400");
  check((await admin("POST", "/session-role", { username: "nobody", role: "admin" }, owner, "role.sync")).json?.updated === 0, "offline username → updated 0");

  // An upload cut off mid-body must not take the game server down.
  for (let i = 0; i < 5; i++) {
    const sock = require("node:net").connect(PORT, "127.0.0.1");
    await new Promise((res) => sock.once("connect", res));
    sock.write("POST /session-role HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{\"username\":");
    await sleep(50);
    sock.destroy();
  }
  await sleep(300);
  r = await admin("GET", "/health", undefined, mod, "dashboard.view");
  check(r.status === 200, "listener (and game server) still up after aborted uploads");

  alice.disconnect();
  await sleep(300);
  r = await admin("GET", "/health", undefined, mod, "dashboard.view");
  check(r.json?.online === 0, `online count back to 0 after disconnect (${r.json?.online})`);
} finally {
  await servers.stop();
}
finish(servers.sfsLog());
