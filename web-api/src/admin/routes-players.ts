// Player lookup for the panel: search, profile, history, and the counts on
// the Home page. Read-only.
import { badRequest as bad } from "../../../admin-panel/shared/listener.ts";
import { isSwid, str } from "./validate.ts";
import type { RouteTable, WebApiDeps } from "./routes.ts";

const notFound = { status: 404, json: { error: "unknown player" } };
const LIMIT = 100;

function identity(d: WebApiDeps, swid: string) {
  const row = d.rawDb.query(`SELECT i.swid, i.username, i.display_name AS displayName, i.created_at AS createdAt, p.role AS role
    FROM player_identity i LEFT JOIN players p ON p.username = i.username WHERE i.swid = ?`).get(swid) as
    { swid: string; username: string; displayName: string | null; createdAt: string | null; role: string | null } | null;
  return row ? { ...row, role: d.effectiveRole(row.username, row.role) } : null;
}

export const playerRoutes: RouteTable = {
  "/player/search": {
    method: "POST", action: "players.view",
    run(body, d) {
      const q = str(body?.q, 1, 64);
      if (q === undefined) return bad("q must be 1-64 characters");
      let rows: { swid: string }[];
      if (q.startsWith("{")) rows = d.rawDb.query("SELECT swid FROM player_identity WHERE swid = ?").all(q) as { swid: string }[];
      else {
        const like = q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
        rows = d.rawDb.query(`SELECT swid FROM player_identity
          WHERE username LIKE ? ESCAPE '\\' COLLATE NOCASE OR display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          ORDER BY display_name COLLATE NOCASE LIMIT 20`).all(like, like) as { swid: string }[];
      }
      const players = rows.map((r) => identity(d, r.swid)).filter((p) => p !== null)
        .map((p) => ({ swid: p!.swid, username: p!.username, displayName: p!.displayName, role: p!.role }));
      return { status: 200, json: { players } };
    },
  },

  "/player/profile": {
    method: "POST", action: "players.view",
    run(body, d) {
      if (!isSwid(body?.swid)) return bad("swid required");
      const who = identity(d, body.swid);
      if (!who) return notFound;
      const count = (q: string) => (d.rawDb.query(q).get(body.swid) as { n: number }).n;
      return {
        status: 200,
        json: {
          ...who,
          ban: d.mod.isBanned(body.swid),
          mute: d.mod.activeMute(body.swid),
          counts: {
            reportsOpen: count("SELECT COUNT(*) AS n FROM mix_reports WHERE reported_swid = ? AND status = 'open'"),
            reportsTotal: count("SELECT COUNT(*) AS n FROM mix_reports WHERE reported_swid = ?"),
            sanctions: count("SELECT COUNT(*) AS n FROM mix_sanctions WHERE swid = ?"),
          },
        },
      };
    },
  },

  "/player/history": {
    method: "POST", action: "players.view",
    run(body, d) {
      if (!isSwid(body?.swid)) return bad("swid required");
      if (!identity(d, body.swid)) return notFound;
      const all = (q: string) => d.rawDb.query(`${q} LIMIT ${LIMIT}`).all(body.swid);
      return {
        status: 200,
        json: {
          sanctions: all("SELECT id, type, level, moderator, reason, created_at FROM mix_sanctions WHERE swid = ? ORDER BY id DESC"),
          bans: all("SELECT rowid, kind, until, set_by, reason, created_at, lifted_at, lifted_by FROM mix_bans WHERE swid = ? ORDER BY rowid DESC"),
          mutes: all("SELECT id, until, set_by, set_by_rank, reason, created_at, lifted_at, lifted_by FROM moderation_mutes WHERE swid = ? ORDER BY id DESC"),
          reportsAgainst: all("SELECT id, reporter_swid, reason, source, status, created_at, resolved_by, resolution FROM mix_reports WHERE reported_swid = ? ORDER BY id DESC"),
          reportsBy: all("SELECT id, reported_swid, reason, source, status, created_at FROM mix_reports WHERE reporter_swid = ? ORDER BY id DESC"),
        },
      };
    },
  },

  "/stats": {
    method: "GET", action: "dashboard.view",
    run(_body, d) {
      const now = new Date().toISOString();
      const n = (q: string, ...a: string[]) => (d.rawDb.query(q).get(...a) as { n: number }).n;
      return {
        status: 200,
        json: {
          openReports: n("SELECT COUNT(*) AS n FROM mix_reports WHERE status = 'open'"),
          activeMutes: n("SELECT COUNT(DISTINCT swid) AS n FROM moderation_mutes WHERE lifted_at IS NULL AND until > ?", now),
          activeBans: n("SELECT COUNT(DISTINCT swid) AS n FROM mix_bans WHERE lifted_at IS NULL AND (until IS NULL OR until > ?)", now),
        },
      };
    },
  },
};
