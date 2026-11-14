// Admin modules load through BUN_OPTIONS=--preload=... with no change to
// public iceberg, and the role-lock trigger refuses role writes to a locked
// account from anywhere but lockedSetRole.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { startServers } from "../../tools/lib/staff-client.ts";
import { lockedSetRole, uninstallRoleLock } from "../../web-api/src/admin/role-lock.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const WEB_PRELOAD = `--preload=${REPO}/web-api/src/admin/index.ts`;
const SFS_PRELOAD = `--preload=${REPO}/smartfox-server/src/admin/index.ts`;
const SECRET = "c".repeat(64);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: WEB_PRELOAD, ADMIN_PANEL_SECRET: SECRET };
const count = (log: string, s: string) => log.split(s).length - 1;

const api = await startWebApi({ env });
const usernameOf = (swid: string) => {
  const db = new Database(api.dbPath, { readonly: true });
  const row = db.query("SELECT username FROM player_identity WHERE swid = ?").get(swid) as { username: string };
  db.close();
  return row.username;
};
const roleOf = (username: string) => {
  const db = new Database(api.dbPath, { readonly: true });
  const row = db.query("SELECT role FROM players WHERE username = ?").get(username) as { role: string | null };
  db.close();
  return row.role;
};
const setRole = (username: string, role: string) => fetch(`${api.base}/api/internal/set-role`, {
  method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ username, role }),
});
const withDb = <T>(fn: (db: Database) => T): T => { const db = new Database(api.dbPath); try { return fn(db); } finally { db.close(); } };

try {
  check(count(api.logs(), "[ADMIN] web-api module loaded") === 1, "web-api preload loads once");
  await createPlayer(api.base, api.dbPath, "{lockme}", "LockMe");
  await createPlayer(api.base, api.dbPath, "{free}", "FreeBird");
  const locked = usernameOf("{lockme}"), free = usernameOf("{free}");

  check(withDb((db) => lockedSetRole(db, locked, "moderator")) === true && roleOf(locked) === "moderator", "lockedSetRole sets the role");
  let r = await setRole(locked, "admin");
  check(!r.ok && roleOf(locked) === "moderator", `in-game set-role on a locked account is refused (${r.status}), role unchanged`);
  check(withDb((db) => lockedSetRole(db, locked, "admin")) === true && roleOf(locked) === "admin", "lockedSetRole can change a locked role");
  r = await setRole(free, "moderator");
  check(r.ok && roleOf(free) === "moderator", "an unlocked account's set-role still works");
  check(withDb((db) => lockedSetRole(db, "NoSuchUser", "admin")) === false, "lockedSetRole on an unknown username returns false");

  await api.restart(env);
  r = await setRole(locked, "player");
  check(!r.ok && roleOf(locked) === "admin", "the lock survives a web-api restart");

  withDb((db) => uninstallRoleLock(db));
  r = await setRole(locked, "player");
  check(r.ok && roleOf(locked) === "player", "after uninstall, set-role works again");
  await api.restart(env);
  check(withDb((db) => db.query("SELECT name FROM sqlite_master WHERE name = 'admin_role_lock'").get()) !== null, "a restart with the preload reinstalls the trigger");

  const before = count(api.logs(), "[ADMIN]");
  await api.restart({ ALLOW_SWID_AUTH: "1", ADMIN_PANEL_SECRET: SECRET });
  check(count(api.logs(), "[ADMIN]") === before, "without BUN_OPTIONS the web-api module doesn't load");
} finally {
  await api.stop();
}

{
  const s = await startServers({ sfsEnv: { BUN_OPTIONS: SFS_PRELOAD, ADMIN_PANEL_SECRET: SECRET } });
  await Bun.sleep(300);
  check(count(s.sfsLog(), "[ADMIN] game-server module loaded") === 1, "game-server preload loads once");
  await s.stop();
}
{
  const s = await startServers({ sfsEntry: "src/supervisor.ts", sfsEnv: { BUN_OPTIONS: SFS_PRELOAD, ADMIN_PANEL_SECRET: SECRET } });
  await Bun.sleep(500);
  check(count(s.sfsLog(), "[ADMIN] game-server module loaded") === 1, `under the supervisor it loads once, in the game server (${count(s.sfsLog(), "[ADMIN] game-server module loaded")})`);
  await s.stop();
}
{
  const s = await startServers({ sfsEnv: { BUN_OPTIONS: SFS_PRELOAD } });
  await Bun.sleep(300);
  check(s.sfsLog().includes("[ADMIN] disabled: ADMIN_PANEL_SECRET missing or short") && !s.sfsLog().includes("module loaded"), "no secret → disabled, logged");
  await s.stop();
}
{
  const s = await startServers();
  await Bun.sleep(300);
  check(!s.sfsLog().includes("[ADMIN]"), "no BUN_OPTIONS → nothing loads in the game server");
  await s.stop();
}

// Running the servers with the admin modules leaves the rest of iceberg
// untouched (edits inside the admin folders themselves don't count).
const status = Bun.spawnSync(["git", "status", "--porcelain", "--", ".", ":!admin-panel", ":!web-api/src/admin", ":!smartfox-server/src/admin"], { cwd: REPO }).stdout.toString();
check(status.trim() === "", `no iceberg files outside the admin folders changed (${JSON.stringify(status.trim())})`);

finish();
