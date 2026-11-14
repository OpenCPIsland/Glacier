// Reason templates (admin and up): the quick reasons shown as chips in the
// action forms. Data in the panel's own database.
import { appendAudit } from "../audit.ts";
import { htmlResponse, type RouteCtx, type RouteDef } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { APPLIES_TO, listTemplates, setTemplateDisabled, upsertTemplate, type AppliesTo } from "../templates.ts";
import { html, visible } from "../web.ts";
import { page } from "./layout.ts";
import { redirect } from "./shared.ts";

export function templateRoutes(store: Store): { exact: Record<string, RouteDef>; match(method: string, pathname: string): RouteDef | null } {
  const msg = (ctx: RouteCtx, text: string, status: number) => htmlResponse(page({ title: "Reason templates", staff: ctx.staff, csrf: ctx.csrf, active: "more", body: html`<p class="error">${text}</p><p><a href="/templates">Back to templates</a></p>` }), status);
  const audit = (ctx: RouteCtx, target: string, params: unknown, result: "ok" | "failed", detail = "") => {
    try { appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "templates.edit", target, params, reason: null, result, detail }); }
    catch (err) { console.error(`[PANEL] audit write failed (templates.edit): ${(err as Error).message}`); }
  };

  const list: RouteDef = {
    action: "templates.edit", method: "GET",
    async run(ctx) {
      const all = listTemplates(store, undefined, true);
      const opts = (sel?: string) => APPLIES_TO.map((a) => html`<option value="${a}"${a === sel ? html` selected` : ""}>${a}</option>`);
      const rows = all.map((t) => html`<tr${t.disabled ? html` class="muted"` : ""}><td colspan="2"><form method="post" action="/templates" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="id" value="${t.id}"><input name="label" value="${visible(t.label)}" maxlength="80" required aria-label="Label"><select name="applies_to" aria-label="Applies to">${opts(t.appliesTo)}</select><input type="number" name="sort" value="${t.sort}" min="-1000" max="1000" aria-label="Order"><button type="submit">Save</button></form></td>
<td><form method="post" action="/templates/${t.id}/toggle"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button type="submit" class="ghost">${t.disabled ? "Enable" : "Disable"}</button></form></td></tr>`);
      const add = html`<h2>Add a template</h2><form method="post" action="/templates" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input name="label" maxlength="80" required placeholder="Label" aria-label="Label"><select name="applies_to" aria-label="Applies to">${opts("any")}</select><input type="number" name="sort" value="0" min="-1000" max="1000" aria-label="Order"><button type="submit">Add</button></form>`;
      return page({ title: "Reason templates", staff: ctx.staff, csrf: ctx.csrf, active: "more", body: html`<p class="muted">Shown as chips in the kick, mute, warn and ban forms. Disabled ones stay in old audit entries but aren't offered.</p><table><thead><tr><th colspan="2">Label · applies to · order</th><th></th></tr></thead><tbody>${rows}</tbody></table>${add}` });
    },
  };

  const save: RouteDef = {
    action: "templates.edit", method: "POST",
    async run(ctx) {
      const f = ctx.form!;
      const idRaw = String(f.get("id") ?? "");
      const id = /^\d{1,9}$/.test(idRaw) ? Number(idRaw) : undefined;
      const t = { id, label: String(f.get("label") ?? ""), appliesTo: String(f.get("applies_to") ?? "") as AppliesTo, sort: Number(f.get("sort") ?? 0) };
      const params = { label: t.label, appliesTo: t.appliesTo, sort: t.sort };
      try {
        const newId = upsertTemplate(store, t);
        audit(ctx, `template:${newId}`, params, "ok");
        return redirect("/templates");
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        audit(ctx, `template:${id ?? "new"}`, params, "failed", err.message);
        return msg(ctx, err.message[0]!.toUpperCase() + err.message.slice(1) + ".", err.message === "unknown template" ? 404 : 400);
      }
    },
  };

  const toggle: RouteDef = {
    action: "templates.edit", method: "POST",
    async run(ctx) {
      const id = Number(ctx.url.pathname.split("/")[2]);
      const cur = listTemplates(store, undefined, true).find((t) => t.id === id);
      if (!cur) { audit(ctx, `template:${id}`, { op: "toggle" }, "failed", "no such template"); return msg(ctx, "No such template.", 404); }
      setTemplateDisabled(store, id, !cur.disabled);
      audit(ctx, `template:${id}`, { op: cur.disabled ? "enable" : "disable" }, "ok");
      return redirect("/templates");
    },
  };

  return {
    exact: { "GET /templates": list, "POST /templates": save },
    match: (method, pathname) => (method === "POST" && /^\/templates\/\d+\/toggle$/.test(pathname) ? toggle : null),
  };
}
