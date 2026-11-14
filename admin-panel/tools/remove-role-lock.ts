// Removes the admin panel's role-lock trigger and table from a game DB.
//   bun admin-panel/tools/remove-role-lock.ts --db /var/lib/iceberg/cpi_data.db
// Stop the web API first, or it reinstalls them on its next start while
// BUN_OPTIONS still preloads the admin module.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { uninstallRoleLock } from "../../web-api/src/admin/role-lock.ts";

const i = process.argv.indexOf("--db");
const path = i > 0 ? process.argv[i + 1] : undefined;
if (!path || !existsSync(path)) {
  console.error("usage: bun admin-panel/tools/remove-role-lock.ts --db <existing cpi_data.db>");
  process.exit(2);
}
const db = new Database(path);
uninstallRoleLock(db);
db.close();
console.log(`role lock removed from ${path}`);
