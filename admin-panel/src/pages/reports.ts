// The reports queue: open and closed reports, filtered by source, newest
// first, 50 per page; resolve with a reason, or act on the player (the
// action form carries ?report=<id> and resolves it).
import { can } from "../../shared/permissions.ts";
import type { Actions } from "../actions.ts";
import type { Clients } from "../clients.ts";
import { doneMessage } from "../done.ts";
import { htmlResponse, type RouteCtx, type RouteDef } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { html, playerText, type SafeHtml } from "../web.ts";
import { when } from "./fmt.ts";
import { page, setOpenReports } from "./layout.ts";
import { DOWN, playerPath, redirect } from "./shared.ts";

const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return p.length ? `?${p.join("&")}` : "";
};

export function reportRoutes(clients: Clients, store: Store, actions: Actions): { exact: Record<string, RouteDef>; match(method: string, pathname: string): RouteDef | null } {
  const ok = (ctx: RouteCtx, a: string) => can(ctx.staff.role, ctx.staff.extras, a);

  const person = (x: { swid: string | null; name: string | null }) =>
    x.swid ? html`<a href="${playerPath(x.swid)}">${playerText(x.name ?? x.swid)}</a>` : html`${playerText(x.name ?? "unknown")}`;

  const list: RouteDef = {
    action: "reports.view", method: "GET",
    async run(ctx) {
      const status = ctx.url.searchParams.get("status") === "closed" ? "closed" : "open";
      const srcRaw = ctx.url.searchParams.get("source");
      const source = srcRaw === "cpi" || srcRaw === "mix" ? srcRaw : undefined;
      const beforeRaw = ctx.url.searchParams.get("before") ?? "";
      const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
      const r = await clients.callWebApi(ctx.actor, "reports.view", "POST", "/reports", { status, ...(source ? { source } : {}), ...(before ? { before } : {}) });
      const stats = await clients.callWebApi(ctx.actor, "dashboard.view", "GET", "/stats");
      if (stats.ok && stats.status === 200) setOpenReports(stats.json?.openReports ?? null);
      const flash = doneMessage(ctx.url.searchParams.get("done"));
      const chip = (label: string, o: Record<string, string | undefined>, on: boolean) => html`<a class="chip${on ? " on" : ""}" href="/reports${qs(o)}">${label}</a>`;
      const chips = html`<div class="chips filters">${chip("Open", { source }, status === "open")}${chip("Closed", { status: "closed", source }, status === "closed")}<span class="sep"></span>${chip("All sources", { status: status === "closed" ? "closed" : undefined }, !source)}${chip("In game", { status: status === "closed" ? "closed" : undefined, source: "cpi" }, source === "cpi")}${chip("Mix", { status: status === "closed" ? "closed" : undefined, source: "mix" }, source === "mix")}</div>`;
      if (!r.ok || r.status !== 200) return page({ title: "Reports", staff: ctx.staff, csrf: ctx.csrf, active: "reports", body: html`${chips}${DOWN}` });
      const reports = r.json.reports as any[];
      const rows = reports.map((x) => {
        const tgt = x.reported.swid as string | null;
        const acts = status === "open" && tgt ? html`<div class="actions">${(["kick", "mute", "warn", "ban"] as const).filter((k) => ok(ctx, `player.${k}`)).map((k) => html`<a class="btn" href="${playerPath(tgt)}/${k}?report=${x.id}">${k[0]!.toUpperCase() + k.slice(1)}</a>`)}</div>` : "";
        const resolve = status === "open" && ok(ctx, "reports.resolve")
          ? html`<form method="post" action="/reports/${x.id}/resolve" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><select name="outcome" aria-label="Outcome"><option value="dismissed">Dismiss</option><option value="actioned">Mark handled</option></select><input name="reason" maxlength="500" required placeholder="Reason" aria-label="Reason"><button type="submit">Resolve</button></form>`
          : html``;
        const closed = status === "closed" ? html`<div class="muted">${x.status} by ${playerText(x.resolvedBy ?? "?")} ${when(x.resolvedAt)}${x.resolution ? html`: ${playerText(x.resolution)}` : ""}</div>` : "";
        return html`<li class="report" data-report="${x.id}"><div class="muted">#${x.id} · ${x.source === "cpi" ? "in game" : "Mix"} · ${when(x.createdAt)}</div>
<div>${person(x.reporter)} reported ${person(x.reported)}</div><div class="pre">${playerText(x.reason ?? "")}</div>${closed}${acts}${resolve}</li>`;
      });
      const older = r.json.next ? html`<p><a class="btn" href="/reports${qs({ status: status === "closed" ? "closed" : undefined, source, before: String(r.json.next) })}">Older reports</a></p>` : "";
      const body = html`${chips}${reports.length ? html`<ul class="reports">${rows}</ul>` : html`<p class="muted">No ${status} reports.</p>`}${older}`;
      return page({ title: "Reports", staff: ctx.staff, csrf: ctx.csrf, active: "reports", flash, body });
    },
  };

  const message = (ctx: RouteCtx, text: string, status: number) => htmlResponse(page({ title: "Report", staff: ctx.staff, csrf: ctx.csrf, active: "reports", body: html`<p class="error">${text}</p><p><a href="/reports">Back to reports</a></p>` }), status);

  const resolve: RouteDef = {
    action: "reports.resolve", method: "POST",
    async run(ctx) {
      const id = Number(ctx.url.pathname.split("/")[2]);
      if (!Number.isInteger(id) || id < 1) return message(ctx, "No such report.", 404);
      const outcome = String(ctx.form?.get("outcome") ?? "");
      if (outcome !== "actioned" && outcome !== "dismissed") return message(ctx, "Pick an outcome.", 400);
      const res = await actions.resolveReport(ctx, id, outcome, String(ctx.form?.get("reason") ?? "").trim());
      if (res === "ok") return redirect("/reports?done=resolved");
      if (res === "gone") return message(ctx, "No such report.", 404);
      if (res === "closed") return message(ctx, "That report was already closed.", 409);
      return message(ctx, "The web API isn't answering. Nothing was changed.", 502);
    },
  };

  return {
    exact: { "GET /reports": list },
    match: (method, pathname) => (method === "POST" && /^\/reports\/\d+\/resolve$/.test(pathname) ? resolve : null),
  };
}
