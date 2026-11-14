// Players: the online list, search, the player page (history, reports,
// notes) and note changes. Actions (kick, mute, ban...) are in actions.ts.
import { can } from "../../shared/permissions.ts";
import { outranks } from "../../shared/rank.ts";
import { appendAudit } from "../audit.ts";
import type { Clients } from "../clients.ts";
import { doneMessage } from "../done.ts";
import { addNote, deleteNote, listNotes, NOTE_MAX } from "../notes.ts";
import { htmlResponse, type RouteCtx, type RouteDef } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { html, playerText, visible, type SafeHtml } from "../web.ts";
import { when } from "./fmt.ts";
import { page } from "./layout.ts";
import { SWID, playerPath, DOWN, redirect, noPlayer } from "./shared.ts";
import type { Forms } from "./action-forms.ts";
import { chatTab } from "./chat.ts";
import { ACTION_OF, type Actions, type Kind } from "../actions.ts";

export { playerPath };

export function playerRoutes(clients: Clients, store: Store, forms: Forms, actions: Actions): { exact: Record<string, RouteDef>; match(method: string, pathname: string): RouteDef | null } {
  const ok = (ctx: RouteCtx, a: string) => can(ctx.staff.role, ctx.staff.extras, a);
  const web = (ctx: RouteCtx, method: "GET" | "POST", path: string, body?: unknown) => clients.callWebApi(ctx.actor, "players.view", method, path, body);

  const online = async (ctx: RouteCtx) => {
    const r = await clients.callGameServer(ctx.actor, "players.view", "GET", "/online");
    return r.ok && r.status === 200 && Array.isArray(r.json?.players) ? (r.json.players as any[]) : null;
  };

  const name = (p: { displayName?: string | null; username?: string | null }) => playerText(p.displayName || p.username || "?");

  async function list(ctx: RouteCtx): Promise<Response | SafeHtml> {
    const q = (ctx.url.searchParams.get("q") ?? "").trim();
    const form = html`<form class="search" action="/players" method="get" role="search"><input type="search" name="q" value="${q}" placeholder="Find a player by name or id" maxlength="64" required aria-label="Player search"><button type="submit">Search</button></form>`;
    if (q) {
      if (q.length > 64) return page({ title: "Players", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`${form}<p class="error">Search with 1 to 64 characters.</p>` });
      const r = await web(ctx, "POST", "/player/search", { q });
      if (!r.ok || r.status !== 200) return page({ title: "Players", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`${form}${DOWN}` });
      const found = (r.json?.players ?? []) as { swid: string; username: string; displayName: string | null; role: string }[];
      if (found.length === 1) return redirect(playerPath(found[0]!.swid));
      const body = found.length === 0 ? html`<p>No players match “${q}”.</p>`
        : html`<table><thead><tr><th>Player</th><th>Account</th><th>Role</th></tr></thead><tbody>${found.map((p) => html`<tr><td><a href="${playerPath(p.swid)}">${name(p)}</a></td><td>${playerText(p.username)}</td><td>${p.role}</td></tr>`)}</tbody></table>`;
      return page({ title: "Players", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`${form}${body}` });
    }
    const on = await online(ctx);
    const rows = on === null ? html`<p class="warn">The game server isn't answering, so the online list is unavailable. Search still works.</p>`
      : on.length === 0 ? html`<p class="muted">Nobody is online.</p>`
      : html`<table><thead><tr><th>Player</th><th>World</th><th>Room</th><th>Role</th><th>Since</th></tr></thead><tbody>${on.map((p) => html`<tr><td><a href="${playerPath(String(p.swid))}">${playerText(p.accountName ?? p.swid)}</a>${p.mutedUntil ? html` <span class="muted">muted</span>` : ""}</td><td>${playerText(p.world)}</td><td>${playerText(p.room)}</td><td>${playerText(p.role)}</td><td>${when(p.connectedAt)}</td></tr>`)}</tbody></table>`;
    return page({ title: "Players", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`${form}<h2>Online now</h2>${rows}` });
  }

  const TABS = [["history", "History", "players.view"], ["reports", "Reports", "reports.view"], ["notes", "Notes", "notes.view"], ["chat", "Chat", "chat.view"]] as const;

  async function show(ctx: RouteCtx): Promise<Response | SafeHtml> {
    const swid = decodeURIComponent(ctx.url.pathname.slice("/players/".length));
    if (!SWID.test(swid)) return noPlayer(ctx);
    const prof = await web(ctx, "POST", "/player/profile", { swid });
    if (!prof.ok) return page({ title: "Player", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: DOWN });
    if (prof.status === 404) return noPlayer(ctx);
    if (prof.status !== 200) return page({ title: "Player", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: DOWN });
    const p = prof.json;
    const live = (await online(ctx))?.find((x) => x.swid === swid) ?? null;
    const tabs = TABS.filter(([, , a]) => ok(ctx, a));
    const want = ctx.url.searchParams.get("tab");
    const tab = tabs.find(([k]) => k === want)?.[0] ?? "history";

    const base = playerPath(swid);
    const self = ctx.staff.linkedSwid !== null && ctx.staff.linkedSwid.toLowerCase() === swid.toLowerCase();
    const mayAct = !self && outranks(ctx.staff.role, p.role);
    const acts: [string, string, string][] = [["kick", "Kick", "player.kick"], ["mute", p.mute ? "Change mute" : "Mute", "player.mute"], ["warn", "Warn", "player.warn"], ["ban", "Ban", "player.ban"]];
    if (p.mute) acts.push(["unmute", "Lift mute", "player.unmute"]);
    if (p.ban) acts.push(["unban", "Lift ban", "player.unban"]);
    const allowed = acts.filter(([, , a]) => ok(ctx, a));
    const dialogs = mayAct ? await forms.dialogs(ctx, swid, visible(p.displayName || p.username), allowed.map(([k]) => k as Kind)) : html``;
    const actionBar = mayAct
      ? html`<div class="actions">${allowed.map(([k, label]) => html`<a class="btn${k === "ban" ? " danger" : ""}" href="${base}/${k}" data-dialog="dlg-${k}">${label}</a>`)}</div>`
      : html`<p class="muted">${self ? "This is your own linked account." : "You can't act on a player of this rank."}</p>`;

    const badges = html`<span class="pill">${p.role}</span>${live ? html` <span class="pill ok">Online · ${playerText(live.room)}</span>` : html` <span class="pill">Offline</span>`}${p.ban ? html` <span class="pill bad">Banned</span>` : ""}${p.mute ? html` <span class="pill warn">Muted until ${when(p.mute.until)}</span>` : ""}`;
    const nav = html`<nav class="tabs" aria-label="Player sections">${tabs.map(([k, label]) => html`<a href="${base}?tab=${k}"${k === tab ? html` class="on" aria-current="page"` : ""}>${label}</a>`)}</nav>`;

    let content: SafeHtml = html``;
    if (tab === "history") content = await historyTab(ctx, swid);
    else if (tab === "reports") content = await reportsTab(ctx, swid);
    else if (tab === "chat") {
      const chat = await chatTab(clients, store, ctx, swid);
      // No audit row, no chat: the view is refused.
      if (chat === null) return htmlResponse(page({ title: "Player", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`<p class="error">The audit log could not be written, so this chat was not shown. Try again.</p><p><a href="${base}">Back to the player</a></p>` }), 500);
      content = chat;
    } else content = notesTab(ctx, swid);

    const body = html`<div class="phead"><div><div class="mono muted">${swid}</div><div>${badges}</div></div></div>${actionBar}${dialogs}${nav}${content}`;
    return page({ title: visible(p.displayName || p.username), staff: ctx.staff, csrf: ctx.csrf, active: "players", flash: doneMessage(ctx.url.searchParams.get("done")), body });
  }

  async function historyTab(ctx: RouteCtx, swid: string): Promise<SafeHtml> {
    const h = await web(ctx, "POST", "/player/history", { swid });
    if (!h.ok || h.status !== 200) return DOWN;
    const j = h.json;
    const items: { at: string; what: string; by: string | null; reason: string | null }[] = [
      ...(j.sanctions ?? []).map((x: any) => ({ at: x.created_at, what: `Disney sanction ${x.type} level ${x.level}`, by: x.moderator, reason: x.reason })),
      ...(j.bans ?? []).map((x: any) => ({ at: x.created_at, what: `Ban (${x.kind})${x.until ? ` until ${x.until}` : " permanent"}${x.lifted_at ? `, lifted by ${x.lifted_by ?? "?"}` : ""}`, by: x.set_by, reason: x.reason })),
      ...(j.mutes ?? []).map((x: any) => ({ at: x.created_at, what: `Mute until ${x.until}${x.lifted_at ? `, lifted by ${x.lifted_by ?? "?"}` : ""}`, by: x.set_by, reason: x.reason })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!items.length) return html`<p class="muted">Nothing on record.</p>`;
    return html`<table><thead><tr><th>When</th><th>What</th><th>By</th><th>Reason</th></tr></thead><tbody>${items.map((i) => html`<tr><td>${when(i.at)}</td><td>${playerText(i.what)}</td><td>${playerText(i.by ?? "")}</td><td>${playerText(i.reason ?? "")}</td></tr>`)}</tbody></table>`;
  }

  async function reportsTab(ctx: RouteCtx, swid: string): Promise<SafeHtml> {
    const h = await web(ctx, "POST", "/player/history", { swid });
    if (!h.ok || h.status !== 200) return DOWN;
    const against: any[] = h.json.reportsAgainst ?? [], by: any[] = h.json.reportsBy ?? [];
    const row = (x: any, other: string) => html`<tr><td>${when(x.created_at)}</td><td><a href="${playerPath(String(x[other]))}">${playerText(x[other])}</a></td><td>${playerText(x.reason ?? "")}</td><td>${playerText(x.status)}</td></tr>`;
    const tbl = (rows: any[], other: string, label: string) => rows.length ? html`<table><thead><tr><th>When</th><th>${label}</th><th>Reason</th><th>Status</th></tr></thead><tbody>${rows.map((x) => row(x, other))}</tbody></table>` : html`<p class="muted">None.</p>`;
    return html`<h2>Reports against</h2>${tbl(against, "reporter_swid", "Reporter")}<h2>Reports made</h2>${tbl(by, "reported_swid", "Reported")}`;
  }

  function notesTab(ctx: RouteCtx, swid: string): SafeHtml {
    const base = playerPath(swid);
    const notes = listNotes(store, swid, false);
    const add = ok(ctx, "notes.edit") ? html`<form action="${base}/notes" method="post" class="stack"><input type="hidden" name="_csrf" value="${ctx.csrf}"><textarea name="body" rows="3" maxlength="${NOTE_MAX}" required aria-label="New note"></textarea><button type="submit">Add note</button></form>` : "";
    const list = notes.length ? html`<ul class="notes">${notes.map((n) => html`<li><div class="muted">${n.author} · ${when(n.at)}</div><div class="pre">${playerText(n.body)}</div>${ok(ctx, "notes.edit") ? html`<form action="${base}/notes/${n.id}/delete" method="post"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button type="submit" class="link">Delete</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">No notes.</p>`;
    return html`${add}${list}`;
  }

  const auditNote = (ctx: RouteCtx, swid: string, op: string, result: "ok" | "denied" | "failed", detail = "") =>
    appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "notes.edit", target: swid, params: { op }, reason: null, result, detail });

  const addNoteRoute: RouteDef = {
    action: "notes.edit", method: "POST",
    async run(ctx) {
      const swid = decodeURIComponent(ctx.url.pathname.split("/")[2] ?? "");
      if (!SWID.test(swid)) return noPlayer(ctx);
      const prof = await web(ctx, "POST", "/player/profile", { swid });
      if (prof.ok && prof.status === 404) return noPlayer(ctx);
      try { addNote(store, swid, ctx.staff.email, String(ctx.form?.get("body") ?? "")); }
      catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return htmlResponse(page({ title: "Note", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`<p class="error">${err.message}</p><p><a href="${playerPath(swid)}?tab=notes">Back</a></p>` }), 400);
      }
      auditNote(ctx, swid, "add", "ok");
      return redirect(`${playerPath(swid)}?tab=notes&done=note-added`);
    },
  };

  const deleteNoteRoute: RouteDef = {
    action: "notes.edit", method: "POST",
    async run(ctx) {
      const parts = ctx.url.pathname.split("/");
      const swid = decodeURIComponent(parts[2] ?? ""), id = Number(parts[4]);
      if (!SWID.test(swid) || !Number.isInteger(id)) return noPlayer(ctx);
      const res = deleteNote(store, swid, id, ctx.staff);
      if (res === "none") return htmlResponse(page({ title: "Note", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`<p>No such note.</p>` }), 404);
      if (res === "not yours") { auditNote(ctx, swid, `delete #${id}`, "denied", "not the author"); return htmlResponse(page({ title: "Note", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`<p class="error">Only the author, or an admin, can delete a note.</p>` }), 403); }
      auditNote(ctx, swid, `delete #${id}`, "ok");
      return redirect(`${playerPath(swid)}?tab=notes&done=note-deleted`);
    },
  };

  const kindRoute = (kind: Kind, method: "GET" | "POST"): RouteDef => ({
    action: ACTION_OF[kind], method,
    async run(ctx) {
      const swid = decodeURIComponent(ctx.url.pathname.split("/")[2] ?? "");
      if (!SWID.test(swid)) return noPlayer(ctx);
      if (method === "GET") return forms.page(ctx, swid, kind);
      const res = await actions.run(kind, ctx, swid);
      if ("error" in res) return htmlResponse(page({ title: "Not done", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`<p class="error">${res.error}</p><p><a href="${playerPath(swid)}">Back to the player</a></p>` }), res.status);
      return redirect(`${playerPath(swid)}?done=${res.done}`);
    },
  });
  const kindRoutes = new Map<string, RouteDef>();
  for (const k of ["kick", "mute", "unmute", "warn", "ban", "unban"] as const) for (const m of ["GET", "POST"] as const) kindRoutes.set(`${m} ${k}`, kindRoute(k, m));

  const listRoute: RouteDef = { action: "players.view", method: "GET", run: list };
  const showRoute: RouteDef = { action: "players.view", method: "GET", run: show };
  return {
    exact: { "GET /players": listRoute, "GET /players/search": listRoute },
    match(method, pathname) {
      if (!pathname.startsWith("/players/")) return null;
      const parts = pathname.split("/"); // ["", "players", swid, ...]
      if (method === "GET" && parts.length === 3 && parts[2] !== "search") return showRoute;
      if (method === "POST" && parts.length === 4 && parts[3] === "notes") return addNoteRoute;
      if (method === "POST" && parts.length === 6 && parts[3] === "notes" && parts[5] === "delete") return deleteNoteRoute;
      if (parts.length === 4 && parts[3] !== undefined && kindRoutes.has(`${method} ${parts[3]}`)) return kindRoutes.get(`${method} ${parts[3]}`)!;
      return null;
    },
  };
}
