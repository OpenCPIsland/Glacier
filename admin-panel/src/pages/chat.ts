// Chat viewer: the Chat tab on the player page, the room/time search page,
// and the owner's retention setting. Chat text is attacker-controlled, so
// it only goes out through playerText. Every view is audited before any
// text is rendered: if the audit row can't be written, nothing is shown.
import { appendAudit } from "../audit.ts";
import type { Clients } from "../clients.ts";
import { doneMessage } from "../done.ts";
import { htmlResponse, type RouteCtx, type RouteDef } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { html, playerText, type SafeHtml } from "../web.ts";
import { when } from "./fmt.ts";
import { page } from "./layout.ts";
import { DOWN, playerPath, redirect } from "./shared.ts";

type ChatRow = { id: number; swid: string; username: string; room: string | null; original: string; shown: string; status: "sent" | "masked" | "blocked" | "muted"; createdAt: string };
type Fetched =
  | { kind: "ok"; rows: ChatRow[]; next: number | null }
  | { kind: "down" }
  | { kind: "refused"; error: string }
  | { kind: "audit" };

const STATUS: Record<ChatRow["status"], [string, string]> = { sent: ["Sent", ""], masked: ["Masked", " warn"], blocked: ["Blocked", " bad"], muted: ["Muted", " warn"] };
const NOTE = "Logged messages were checked by the filter. They may not have reached the room (a muted player, or a chat command).";
const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return p.length ? `?${p.join("&")}` : "";
};

/** Fetches a page of chat, then writes the audit row. Fails closed: no audit row, no rows returned. */
async function audited(clients: Clients, store: Store, ctx: RouteCtx, path: string, body: unknown, target: string, params: Record<string, unknown>): Promise<Fetched> {
  const r = await clients.callWebApi(ctx.actor, "chat.view", "POST", path, body);
  if (!r.ok) return { kind: "down" };
  if (r.status === 400) return { kind: "refused", error: String(r.json?.error ?? "refused") };
  if (r.status !== 200 || !Array.isArray(r.json?.rows)) return { kind: "down" };
  const rows = r.json.rows as ChatRow[];
  try {
    appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "chat.view", target, params: { ...params, rows: rows.length }, reason: null, result: "ok", detail: null });
  } catch (err) {
    console.error(`[PANEL] audit write failed (chat.view by ${ctx.staff.email}): ${(err as Error).message}`);
    return { kind: "audit" };
  }
  return { kind: "ok", rows, next: typeof r.json.next === "number" ? r.json.next : null };
}

function table(rows: ChatRow[], withPlayer: boolean): SafeHtml {
  if (!rows.length) return html`<p class="muted">No messages.</p>`;
  const body = rows.map((x) => {
    const [label, cls] = STATUS[x.status] ?? [String(x.status), ""];
    const typed = x.original !== x.shown ? html`<div class="muted">Typed: ${playerText(x.original)}</div>` : "";
    return html`<tr><td>${when(x.createdAt)}</td>${withPlayer ? html`<td><a href="${playerPath(x.swid)}">${playerText(x.username)}</a></td>` : ""}<td>${x.room ? playerText(x.room) : html`<span class="muted">unknown room</span>`}</td><td><span class="pill${cls}">${label}</span></td><td class="pre">${playerText(x.shown)}${typed}</td></tr>`;
  });
  return html`<table><thead><tr><th>When</th>${withPlayer ? html`<th>Player</th>` : ""}<th>Room</th><th>Status</th><th>Message</th></tr></thead><tbody>${body}</tbody></table>`;
}

const problem = (f: Exclude<Fetched, { kind: "ok" }>): SafeHtml =>
  f.kind === "refused" ? html`<p class="error">${f.error}</p>` : f.kind === "audit" ? html`<p class="error">The audit log could not be written, so this chat was not shown. Try again.</p>` : DOWN;

/** The Chat tab's content, or null when the view was refused because the audit row couldn't be written (the caller answers 500). */
export async function chatTab(clients: Clients, store: Store, ctx: RouteCtx, swid: string): Promise<SafeHtml | null> {
  const beforeRaw = ctx.url.searchParams.get("before") ?? "";
  const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
  const f = await audited(clients, store, ctx, "/chat/by-player", { swid, ...(before ? { before } : {}) }, `player:${swid}`, { before: before ?? null });
  if (f.kind === "audit") return null;
  if (f.kind !== "ok") return problem(f);
  const older = f.next ? html`<p><a class="btn" href="${playerPath(swid)}${qs({ tab: "chat", before: String(f.next) })}">Older messages</a></p>` : "";
  return html`<p class="muted">${NOTE}</p>${table(f.rows, false)}${older}`;
}

const LOCAL = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
/** The datetime-local value (read as UTC) or a full ISO string, as ISO for the web API; undefined if neither. */
const toIso = (v: string): string | undefined => (LOCAL.test(v) ? `${v}:00Z` : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) ? v : undefined);

export function chatRoutes(clients: Clients, store: Store): { exact: Record<string, RouteDef>; match(method: string, pathname: string): RouteDef | null } {
  const retention = async (ctx: RouteCtx): Promise<number | null> => {
    const r = await clients.callWebApi(ctx.actor, "chat.view", "POST", "/chat/retention/get", {});
    return r.ok && r.status === 200 && Number.isInteger(r.json?.days) ? r.json.days : null;
  };

  const list: RouteDef = {
    action: "chat.view", method: "GET",
    async run(ctx) {
      const sp = ctx.url.searchParams;
      const room = (sp.get("room") ?? "").trim(), q = (sp.get("q") ?? "").trim();
      const fromRaw = sp.get("from") ?? "", toRaw = sp.get("to") ?? "";
      const beforeRaw = sp.get("before") ?? "";
      const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
      const days = await retention(ctx);
      const owner = ctx.staff.role === "owner";

      // `to` is exclusive, so the default end is the start of the next minute: a message from seconds ago is inside the window.
      const hour = new Date(Math.ceil((Date.now() + 1) / 60_000) * 60_000);
      const defTo = hour.toISOString().slice(0, 16), defFrom = new Date(hour.getTime() - 3600_000).toISOString().slice(0, 16);
      const form = html`<form method="get" action="/chat" class="stack">
<label>Room <input name="room" maxlength="64" value="${room}" placeholder="any room"></label>
<label>From (UTC) <input type="datetime-local" name="from" value="${fromRaw || defFrom}" required></label>
<label>To (UTC) <input type="datetime-local" name="to" value="${toRaw || defTo}" required></label>
<label>Text contains <input name="q" maxlength="64" value="${q}"></label>
<button type="submit">Search</button></form>`;
      const keep = days === null ? "" : html`<p class="muted">Chat is kept for ${days} days.</p>`;
      const form2 = owner ? html`<h2>Retention</h2><form method="post" action="/chat/retention" class="stack"><input type="hidden" name="_csrf" value="${ctx.csrf}">
<label>Keep chat for (days, 1-365) <input name="days" inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" required value="${days ?? ""}"></label>
<label>Reason <input name="reason" maxlength="500" required></label>
<button type="submit">Save retention</button></form>` : "";
      const wrap = (inner: SafeHtml | string) => page({ title: "Chat search", staff: ctx.staff, csrf: ctx.csrf, active: "more", flash: doneMessage(sp.get("done")), body: html`<p class="muted">${NOTE}</p>${form}${inner}${keep}${form2}` });

      if (!fromRaw || !toRaw) return wrap("");
      const from = toIso(fromRaw), to = toIso(toRaw);
      if (!from || !to) return wrap(html`<p class="error">Pick a start and end time.</p>`);
      const body: Record<string, unknown> = { from, to };
      if (room) body.room = room;
      if (q) body.q = q;
      if (before) body.before = before;
      const f = await audited(clients, store, ctx, "/chat/search", body, `room:${room || "any"}`, { from, to, ...(q ? { q } : {}), before: before ?? null });
      if (f.kind === "audit") return htmlResponse(wrap(problem(f)), 500);
      if (f.kind !== "ok") return wrap(problem(f));
      const older = f.next ? html`<p><a class="btn" href="/chat${qs({ room, from: fromRaw, to: toRaw, q, before: String(f.next) })}">Older messages</a></p>` : "";
      return wrap(html`${table(f.rows, true)}${older}`);
    },
  };

  const setRetention: RouteDef = {
    action: "chat.retention", method: "POST",
    async run(ctx) {
      const f = ctx.form!;
      const reason = String(f.get("reason") ?? "").trim();
      const daysRaw = String(f.get("days") ?? "").trim();
      const msg = (text: string, status: number) => htmlResponse(page({ title: "Chat retention", staff: ctx.staff, csrf: ctx.csrf, active: "more", body: html`<p class="error">${text}</p><p><a href="/chat">Back to chat</a></p>` }), status);
      const audit = (result: "ok" | "error" | "unreachable", params: unknown, detail: string | null) => {
        try { appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "chat.retention", target: "setting:chat_log_retention_days", params, reason, result, detail }); }
        catch (err) { console.error(`[PANEL] audit write failed (chat.retention): ${(err as Error).message}`); }
      };
      if (!/^\d{1,3}$/.test(daysRaw) || Number(daysRaw) < 1 || Number(daysRaw) > 365) return msg("Retention must be a whole number of days from 1 to 365.", 400);
      const days = Number(daysRaw);
      const old = await retention(ctx);
      const r = await clients.callWebApi(ctx.actor, "chat.retention", "POST", "/chat/retention/set", { days });
      const params = { from: old, to: days };
      if (!r.ok) { audit("unreachable", params, r.detail); return msg("The web API isn't answering. Nothing was changed.", 502); }
      if (r.status !== 200) { audit("error", params, String(r.json?.error ?? r.status)); return msg(`Refused: ${r.json?.error ?? "error " + r.status}.`, r.status === 400 ? 400 : 502); }
      audit("ok", params, null);
      return redirect("/chat?done=retention-saved");
    },
  };

  return { exact: { "GET /chat": list, "POST /chat/retention": setRetention }, match: () => null };
}
