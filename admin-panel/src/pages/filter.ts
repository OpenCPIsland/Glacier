// The chat word filter (admin and up): list, add, remove. Rules live in the
// web API; every change needs a reason and is audited.
import { appendAudit } from "../audit.ts";
import type { Clients } from "../clients.ts";
import { htmlResponse, type RouteCtx, type RouteDef } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { html, playerText } from "../web.ts";
import { page } from "./layout.ts";
import { redirect } from "./shared.ts";

export function filterRoutes(clients: Clients, store: Store): { exact: Record<string, RouteDef>; match(method: string, pathname: string): RouteDef | null } {
  const msg = (ctx: RouteCtx, text: string, status: number) => htmlResponse(page({ title: "Word filter", staff: ctx.staff, csrf: ctx.csrf, active: "more", body: html`<p class="error">${text}</p><p><a href="/filter">Back to the filter</a></p>` }), status);
  const audit = (ctx: RouteCtx, target: string, params: unknown, result: "ok" | "failed", detail = "") => {
    try { appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "filter.edit", target, params, reason: String(ctx.form?.get("reason") ?? "").trim(), result, detail }); }
    catch (err) { console.error(`[PANEL] audit write failed (filter.edit): ${(err as Error).message}`); }
  };

  const list: RouteDef = {
    action: "filter.view", method: "GET",
    async run(ctx) {
      const r = await clients.callWebApi(ctx.actor, "filter.view", "GET", "/filter");
      if (!r.ok || r.status !== 200) return page({ title: "Word filter", staff: ctx.staff, csrf: ctx.csrf, active: "more", body: html`<p class="error">The web API isn't answering. Try again in a moment.</p>` });
      const rules = r.json.rules as { id: number; pattern: string; kind: string; action: string }[];
      const edit = ctx.staff.role !== "moderator";
      const rows = rules.map((x) => html`<tr><td><code>${playerText(x.pattern)}</code></td><td>${x.kind}</td><td>${x.action}</td><td>${edit ? html`<form method="post" action="/filter/${x.id}/remove" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input name="reason" maxlength="500" required placeholder="Reason" aria-label="Reason"><button type="submit" class="ghost">Remove</button></form>` : ""}</td></tr>`);
      const add = html`<h2>Add a rule</h2><form method="post" action="/filter/add" class="stack"><input type="hidden" name="_csrf" value="${ctx.csrf}">
<label>Pattern <input name="pattern" maxlength="200" required></label>
<label>Kind <select name="kind"><option value="word">Word</option><option value="regex">Regex</option></select></label>
<label>What it does <select name="action"><option value="mask">Mask the text</option><option value="block">Block the message</option></select></label>
<label>Reason <input name="reason" maxlength="500" required></label>
<button type="submit">Add rule</button></form>`;
      return page({ title: "Word filter", staff: ctx.staff, csrf: ctx.csrf, active: "more", body: html`${rules.length ? html`<table><thead><tr><th>Pattern</th><th>Kind</th><th>Action</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : html`<p class="muted">No rules.</p>`}${add}` });
    },
  };

  const add: RouteDef = {
    action: "filter.edit", method: "POST",
    async run(ctx) {
      const f = ctx.form!;
      const body = { pattern: String(f.get("pattern") ?? ""), kind: String(f.get("kind") ?? ""), action: String(f.get("action") ?? ""), reason: String(f.get("reason") ?? "").trim() };
      const r = await clients.callWebApi(ctx.actor, "filter.edit", "POST", "/filter/add", body);
      const params = { op: "add", pattern: body.pattern, kind: body.kind, action: body.action };
      if (!r.ok) { audit(ctx, "rule", params, "failed", "unreachable"); return msg(ctx, "The web API isn't answering. Nothing was changed.", 502); }
      if (r.status !== 200) { audit(ctx, "rule", params, "failed", String(r.json?.error ?? r.status)); return msg(ctx, `Refused: ${r.json?.error ?? "error " + r.status}.`, r.status === 400 ? 400 : 502); }
      audit(ctx, `rule:${r.json?.id}`, params, "ok");
      return redirect("/filter");
    },
  };

  const remove: RouteDef = {
    action: "filter.edit", method: "POST",
    async run(ctx) {
      const id = Number(ctx.url.pathname.split("/")[2]);
      const r = await clients.callWebApi(ctx.actor, "filter.edit", "POST", "/filter/remove", { id, reason: String(ctx.form?.get("reason") ?? "").trim() });
      const params = { op: "remove" };
      if (!r.ok) { audit(ctx, `rule:${id}`, params, "failed", "unreachable"); return msg(ctx, "The web API isn't answering. Nothing was changed.", 502); }
      if (r.status !== 200) { audit(ctx, `rule:${id}`, params, "failed", String(r.json?.error ?? r.status)); return msg(ctx, `Refused: ${r.json?.error ?? "error " + r.status}.`, r.status === 400 ? 400 : 502); }
      if (!r.json?.removed) { audit(ctx, `rule:${id}`, params, "failed", "no such rule"); return msg(ctx, "No such rule.", 404); }
      audit(ctx, `rule:${id}`, params, "ok");
      return redirect("/filter");
    },
  };

  return {
    exact: { "GET /filter": list, "POST /filter/add": add },
    match: (method, pathname) => (method === "POST" && /^\/filter\/\d+\/remove$/.test(pathname) ? remove : null),
  };
}
