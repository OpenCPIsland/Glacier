// A broken or half-copied admin module must never stop the web API or the
// game server: they start, log the failure, and run as plain iceberg.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { startServers, sleep } from "../../tools/lib/staff-client.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "a".repeat(64);

// A copy of the deployed layout with shared/listener.ts missing, like a
// partly finished rsync.
const top = mkdtempSync(join(tmpdir(), "admin-broken-"));
for (const d of ["admin-panel/shared", "web-api/src/admin", "smartfox-server/src/admin"]) cpSync(`${REPO}/${d}`, `${top}/${d}`, { recursive: true, filter: (p) => !p.includes("/.git") });
rmSync(`${top}/admin-panel/shared/listener.ts`);

const api = await startWebApi({ env: { BUN_OPTIONS: `--preload=${top}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: "0" } });
try {
  const r = await fetch(`${api.base}/cdn/party-schedule.json`);
  check(r.status === 200, `web API serves with a broken admin module (${r.status})`);
  check(api.logs().includes("[ADMIN] web-api module failed to start"), "the failure is logged");
} finally {
  await api.stop();
}

const s = await startServers({ sfsEnv: { BUN_OPTIONS: `--preload=${top}/smartfox-server/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, SFS_ADMIN_PORT: "0" } });
try {
  await sleep(500);
  const up = await new Promise<boolean>((res) => { const c = require("node:net").connect(s.sfsPort, "127.0.0.1"); c.once("connect", () => { c.destroy(); res(true); }); c.once("error", () => res(false)); });
  check(up, "game server listens with a broken admin module");
  check(s.sfsLog().includes("[ADMIN] game-server module failed to start"), `the failure is logged (${JSON.stringify(s.sfsLog().slice(0, 300))})`);
} finally {
  await s.stop();
}
rmSync(top, { recursive: true, force: true });
finish();
