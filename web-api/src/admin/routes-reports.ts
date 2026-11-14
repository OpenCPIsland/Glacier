// The reports queue and the word filter for the panel.
import { badRequest as bad } from "../../../admin-panel/shared/listener.ts";
import { int, reason as reasonOf, str } from "./validate.ts";
import type { RouteTable, WebApiDeps } from "./routes.ts";

const PAGE = 50;

/** Reporter / reported as {swid, name}: unknown CPI names are stored as "name:<display>". */
function who(d: WebApiDeps, stored: string): { swid: string | null; name: string | null } {
  if (stored.startsWith("name:")) return { swid: null, name: stored.slice(5) };
  const row = d.rawDb.query("SELECT display_name AS name, username FROM player_identity WHERE swid = ?").get(stored) as { name: string | null; username: string } | null;
  return { swid: stored, name: row ? row.name ?? row.username : null };
}

// A regex the filter runs on every chat message must not take exponential
// time: refuse a quantified group that holds a quantifier ("(a+)+",
// "(\w*)*"), the usual shape of catastrophic backtracking. Not a proof of
// safety; rules are admin-only and audited.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

export const reportRoutes: RouteTable = {
  "/reports": {
    method: "POST", action: "reports.view",
    run(body, d) {
      const status = body?.status;
      if (status !== "open" && status !== "closed") return bad("status must be open or closed");
      if (body.source !== undefined && body.source !== "cpi" && body.source !== "mix") return bad("source must be cpi or mix");
      const before = body.before === undefined ? Number.MAX_SAFE_INTEGER : int(body.before, 1, Number.MAX_SAFE_INTEGER);
      if (before === undefined) return bad("before must be a report id");
      const rows = d.rawDb.query(`SELECT id, reporter_swid, reported_swid, reason, source, status, created_at, resolved_by, resolved_at, resolution
        FROM mix_reports WHERE ${status === "open" ? "status = 'open'" : "status != 'open'"} AND id < ? ${body.source ? "AND source = ?" : ""}
        ORDER BY id DESC LIMIT ${PAGE + 1}`).all(...(body.source ? [before, body.source] : [before])) as any[];
      const page = rows.slice(0, PAGE).map((r) => ({
        id: r.id, source: r.source, reason: r.reason, status: r.status, createdAt: r.created_at,
        reported: who(d, r.reported_swid), reporter: who(d, r.reporter_swid),
        resolvedBy: r.resolved_by, resolvedAt: r.resolved_at, resolution: r.resolution,
      }));
      return { status: 200, json: { reports: page, next: rows.length > PAGE ? page[page.length - 1]!.id : null } };
    },
  },

  "/report/resolve": {
    method: "POST", action: "reports.resolve",
    run(body, d, actor) {
      const id = int(body?.id, 1, Number.MAX_SAFE_INTEGER);
      if (id === undefined) return bad("id required");
      if (body.status !== "actioned" && body.status !== "dismissed") return bad("status must be actioned or dismissed");
      const reason = reasonOf(body.reason);
      if (reason === undefined) return bad("a reason (1-500 characters) is required");
      const row = d.rawDb.query("SELECT status FROM mix_reports WHERE id = ?").get(id) as { status: string } | null;
      if (!row) return { status: 404, json: { error: "unknown report" } };
      const changed = d.rawDb.query(`UPDATE mix_reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ?
        WHERE id = ? AND status = 'open'`).run(body.status, `panel:${actor.email}`, new Date().toISOString(), reason, id).changes;
      if (changed === 0) return { status: 409, json: { error: "already closed" } };
      return { status: 200, json: { ok: true } };
    },
  },

  "/filter": {
    method: "GET", action: "filter.view",
    run: (_b, d) => ({ status: 200, json: { rules: d.mod.listRules() } }),
  },

  "/filter/add": {
    method: "POST", action: "filter.edit",
    run(body, d) {
      const pattern = str(body?.pattern, 1, 200);
      if (pattern === undefined) return bad("pattern must be 1-200 characters");
      if (body.kind !== "word" && body.kind !== "regex") return bad("kind must be word or regex");
      if (body.action !== "mask" && body.action !== "block") return bad("action must be mask or block");
      if (reasonOf(body.reason) === undefined) return bad("a reason (1-500 characters) is required");
      if (body.kind === "regex") {
        try { new RegExp(pattern, "giu"); } catch (e) { return bad(`not a valid regex: ${(e as Error).message}`.slice(0, 200)); }
        if (NESTED_QUANTIFIER.test(pattern)) return bad("a repeated group with a repeat inside (like (a+)+) can freeze chat; rewrite it");
      }
      return { status: 200, json: { id: d.mod.addRule(pattern, body.kind, body.action) } };
    },
  },

  "/filter/remove": {
    method: "POST", action: "filter.edit",
    run(body, d) {
      const id = int(body?.id, 1, Number.MAX_SAFE_INTEGER);
      if (id === undefined) return bad("id required");
      if (reasonOf(body.reason) === undefined) return bad("a reason (1-500 characters) is required");
      return { status: 200, json: { removed: d.mod.removeRule(id) } };
    },
  },
};
