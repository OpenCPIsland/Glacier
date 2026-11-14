// The box runs the admin code from a separate copy (deploy-admin.sh): only
// admin-panel/ and web-api|smartfox-server/src/admin/. Nothing in the admin
// modules may import a path that exists only in the full repo, or the
// listener fails to load there while every in-repo test still passes.
import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeChecker } from "../../tools/lib/harness.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const box = mkdtempSync(join(tmpdir(), "admin-box-"));
for (const d of ["admin-panel/shared", "web-api/src/admin", "smartfox-server/src/admin"]) {
  mkdirSync(join(box, d), { recursive: true });
  cpSync(join(REPO, d), join(box, d), { recursive: true });
}
// routes.ts pulls in every other web API admin file; the game server admin
// module has no import outside its own folder.
for (const entry of ["web-api/src/admin/routes.ts"]) {
  const r = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(box, entry))})`], { cwd: box });
  check(r.exitCode === 0, `${entry} loads from the box layout${r.exitCode === 0 ? "" : ": " + r.stderr.toString().split("\n").slice(0, 3).join(" ")}`);
}
finish();
