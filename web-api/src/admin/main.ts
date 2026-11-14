// The web API admin module, loaded by index.ts (the preload shim).
// Nothing in public iceberg refers to it. It reaches the server's own
// modules through process.cwd() (the server's working directory), so it
// gets the same instances the server uses. It must never throw: a broken
// admin module must not take the game's web API down.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { installRoleLock } from "./role-lock.ts";
import { startAdminListener } from "./routes.ts";

export const SECRET_OK = /^[0-9a-f]{64,}$/i.test(process.env.ADMIN_PANEL_SECRET ?? "");

try {
  const dbModule = `${process.cwd()}/src/database.ts`;
  if (!existsSync(dbModule)) throw new Error(`no ${dbModule}; is the working directory web-api/?`);
  const dbm: any = await import(dbModule); // creates and migrates the schema first
  const staff: any = await import(`${process.cwd()}/src/utils/staffRoles.ts`);
  const mod: any = await import(`${process.cwd()}/src/services/moderation.ts`);
  const chat: any = await import(`${process.cwd()}/src/services/chatLog.ts`);
  const cdn: any =await import(`${process.cwd()}/src/services/cdnConfig.ts`);
  const db = new Database(process.env.ICEBERG_DB_PATH || `${process.cwd()}/src/cpi_data.db`);
  installRoleLock(db);
  if (!SECRET_OK) console.error("[ADMIN] disabled: ADMIN_PANEL_SECRET missing or short");
  else {
    console.log("[ADMIN] web-api module loaded");
    startAdminListener(process.env.ADMIN_PANEL_SECRET!, Number(process.env.WEBAPI_ADMIN_PORT ?? 8091), {
      rawDb: db,
      findUsernameNoCase: dbm.findUsernameNoCase,
      getPlayerIdentityAndRole: dbm.getPlayerIdentityAndRole,
      effectiveRole: staff.effectiveRole,
      isStaffAdmin: staff.isStaffAdmin,
      mod,
      chat,
      cdn: { get: cdn.getCdnConfig, set: cdn.setCdnConfig, validate: cdn.validateCdnConfigWithReleases, listReleases: cdn.listReleases, importStaged: cdn.importStagedRelease },
    });
  }
} catch (err) {
  console.error(`[ADMIN] web-api module failed to start: ${(err as Error).message}`);
}
