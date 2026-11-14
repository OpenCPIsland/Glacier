// Room chat log reads and the retention setting for the panel (chat.view /
// chat.retention). Chat text comes back as stored; escaping it is the
// panel's job, and the panel audits every view.
import { badRequest as bad } from "../../../admin-panel/shared/listener.ts";
import { int, isSwid, str } from "./validate.ts";
import type { RouteTable } from "./routes.ts";

const MAX_WINDOW_MS = 24 * 3600_000;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

/** An ISO timestamp as canonical UTC ISO (the form chat_log stores), or undefined. */
function iso(v: unknown): string | undefined {
  if (typeof v !== "string" || !ISO.test(v)) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Absent cursor is fine; a present one must be a positive integer. */
function cursor(v: unknown): { ok: true; before?: number } | { ok: false } {
  if (v === undefined) return { ok: true };
  const n = int(v, 1, Number.MAX_SAFE_INTEGER);
  return n === undefined ? { ok: false } : { ok: true, before: n };
}

export const chatRoutes: RouteTable = {
  "/chat/by-player": {
    method: "POST", action: "chat.view",
    run(body, d) {
      if (!isSwid(body?.swid)) return bad("swid required");
      const c = cursor(body?.before);
      if (!c.ok) return bad("before must be a positive integer");
      return { status: 200, json: d.chat.queryByPlayer(body.swid, c.before) };
    },
  },

  "/chat/search": {
    method: "POST", action: "chat.view",
    run(body, d) {
      const from = iso(body?.from), to = iso(body?.to);
      if (!from || !to) return bad("from and to must be ISO timestamps");
      const span = Date.parse(to) - Date.parse(from);
      if (span <= 0) return bad("to must be after from");
      if (span > MAX_WINDOW_MS) return bad("the window is at most 24 hours");
      let room: string | undefined, text: string | undefined;
      if (body?.room !== undefined && (room = str(body.room, 1, 64)) === undefined) return bad("room must be 1-64 characters");
      if (body?.q !== undefined && (text = str(body.q, 1, 64)) === undefined) return bad("q must be 1-64 characters");
      const c = cursor(body?.before);
      if (!c.ok) return bad("before must be a positive integer");
      return { status: 200, json: d.chat.querySearch({ room, from, to, text, before: c.before }) };
    },
  },

  "/chat/retention/get": {
    method: "POST", action: "chat.view",
    run: (_body, d) => ({ status: 200, json: { days: d.chat.getRetentionDays() } }),
  },

  "/chat/retention/set": {
    method: "POST", action: "chat.retention",
    run(body, d) {
      const days = int(body?.days, 1, 365);
      if (days === undefined) return bad("days must be a whole number from 1 to 365");
      d.chat.setRetentionDays(days);
      // Shortening is usually a privacy decision: rows past the new window go now, not at the next 6-hourly purge.
      d.chat.purgeChatLog();
      return { status: 200, json: { days } };
    },
  },
};
