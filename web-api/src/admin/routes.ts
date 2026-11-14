// The web API's admin routes, served by the shared signed listener
// (admin-panel/shared/listener.ts) on 127.0.0.1:8091.
import http from "node:http";
import type { Database } from "bun:sqlite";
import { startSignedListener, badRequest as bad, type Reply, type Route } from "../../../admin-panel/shared/listener.ts";
import { cdnRoutes, type CdnStore } from "./routes-cdn.ts";
import { lockedSetRole, unlockRole, type GameRole } from "./role-lock.ts";
import type { Actor } from "../../../admin-panel/shared/signing.ts";
import { playerRoutes } from "./routes-players.ts";
import { moderationRoutes } from "./routes-moderation.ts";
import { reportRoutes } from "./routes-reports.ts";
import { chatRoutes } from "./routes-chat.ts";

const GAME_ROLES = new Set(["player", "moderator", "admin"]);

export interface WebApiDeps {
  rawDb: Database;
  findUsernameNoCase(name: string): string | null;
  getPlayerIdentityAndRole(swid: string): { username: string; role: string | null } | null;
  effectiveRole(username: string, stored: string | null): string;
  isStaffAdmin(username: string): boolean;
  /** The server's own services/moderation.ts (same module instance). */
  mod: typeof import("../services/moderation.ts");
  /** The server's own services/chatLog.ts (same module instance). */
  chat: typeof import("../services/chatLog.ts");
  cdn: CdnStore;
}

export type Handler = (body: any, deps: WebApiDeps, actor: Actor) => Reply;
export type RouteTable = Record<string, { method: "GET" | "POST"; action: string; run: Handler }>;


const roleRoutes: RouteTable = {
  "/health": { method: "GET", action: "dashboard.view", run: () => ({ status: 200, json: { ok: true } }) },

  // Read-only lookup, so admins viewing the Staff page can use it.
  "/player/resolve": {
    method: "POST", action: "staff.view",
    run(body, d) {
      const q = body?.query;
      if (typeof q !== "string" || q.length === 0 || q.length > 128) return bad("query must be a username or swid");
      let swid: string | null = null, username: string | null = null;
      if (q.startsWith("{")) {
        swid = q;
        username = d.getPlayerIdentityAndRole(q)?.username ?? null;
      } else {
        username = d.findUsernameNoCase(q);
        if (username) swid = (d.rawDb.query("SELECT swid FROM player_identity WHERE username = ? LIMIT 1").get(username) as { swid: string } | null)?.swid ?? null;
      }
      if (!username || !swid) return { status: 404, json: { error: "unknown player" } };
      const stored = (d.rawDb.query("SELECT role FROM players WHERE username = ?").get(username) as { role: string | null } | null)?.role ?? null;
      return { status: 200, json: { swid, username, role: d.effectiveRole(username, stored), configAdmin: d.isStaffAdmin(username) } };
    },
  },

  "/role": {
    method: "POST", action: "role.sync",
    run(body, d) {
      const { username, role } = body ?? {};
      if (typeof username !== "string" || !GAME_ROLES.has(role)) return bad("username and role (player|moderator|admin) required");
      const canonical = d.findUsernameNoCase(username);
      if (!canonical) return { status: 404, json: { error: "unknown username" } };
      if (d.isStaffAdmin(canonical)) return { status: 409, json: { error: "config admin" } };
      lockedSetRole(d.rawDb, canonical, role as GameRole);
      return { status: 200, json: { username: canonical, role } };
    },
  },

  "/role/unlock": {
    method: "POST", action: "role.sync",
    run(body, d) {
      const username = body?.username;
      if (typeof username !== "string") return bad("username required");
      unlockRole(d.rawDb, d.findUsernameNoCase(username) ?? username);
      return { status: 200, json: { ok: true } };
    },
  },
};

export function startAdminListener(secret: string, port: number, deps: WebApiDeps): http.Server {
  const bound: Record<string, Route> = {};
  const routes: RouteTable = { ...roleRoutes, ...playerRoutes, ...moderationRoutes, ...reportRoutes, ...chatRoutes };
  for (const [path, r] of Object.entries(routes)) bound[path] = { method: r.method, action: r.action, run: (body, actor) => r.run(body, deps, actor) };
  Object.assign(bound, cdnRoutes(deps.cdn));
  return startSignedListener("web-api", secret, port, bound);
}
