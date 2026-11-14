// The action forms: one body per action, used both as a <dialog> on the
// player page and as a plain page (the no-JS fallback).
import { can } from "../../shared/permissions.ts";
import { MOD_BAN_MAX_HOURS, MUTE_MAX_MINUTES } from "../../shared/rank.ts";
import { ACTION_OF, KINDS, isKind, type Actions, type Kind, type LadderType } from "../actions.ts";
import type { Clients } from "../clients.ts";
import { htmlResponse, type RouteCtx } from "../pipeline.ts";
import { listTemplates, type AppliesTo } from "../templates.ts";
import type { Store } from "../store.ts";
import { html, visible, SafeHtml } from "../web.ts";
import { page } from "./layout.ts";
import { DOWN, SWID, noPlayer, playerPath } from "./shared.ts";

const TITLE: Record<Kind, string> = { kick: "Kick", mute: "Mute", unmute: "Lift mute", warn: "Warn", ban: "Ban", unban: "Lift ban" };

interface FormData_ { swid: string; name: string; report?: number; ladder: { types: LadderType[]; suggested: Record<string, number> } | null }

export function makeForms(clients: Clients, store: Store, actions: Actions) {
  const ok = (ctx: RouteCtx, a: string) => can(ctx.staff.role, ctx.staff.extras, a);

  // Rungs the role can't use are sent as "restricted": nothing about them
  // is offered, and the form can't be submitted at that level.
  function ladderJson(ctx: RouteCtx, ladder: NonNullable<FormData_["ladder"]>): SafeHtml {
    const perm = ok(ctx, "player.ban.permanent");
    const types = ladder.types.map((t) => ({ ...t, rungs: t.rungs.map((r) => (!perm && (r.outcome === "permanent" || r.outcome === "lock") ? { level: r.level, outcome: "restricted", hours: null } : r)) }));
    // "<" can't end the script block: escape it in the JSON text.
    const text = JSON.stringify({ types, suggested: ladder.suggested }).replace(/</g, "\\u003c");
    return html`<script type="application/json" id="ladder">${new SafeHtml(text)}</script>`;
  }

  function chips(kind: Kind): SafeHtml {
    const applies: AppliesTo = kind === "unmute" || kind === "unban" ? "any" : (kind as AppliesTo);
    const t = listTemplates(store, applies);
    return html`<div class="chips" aria-label="Reason templates">${t.map((x) => html`<button type="button" class="chip" data-template="${x.label}">${x.label}</button>`)}</div>`;
  }

  function fields(kind: Kind, ctx: RouteCtx, d: FormData_): SafeHtml {
    switch (kind) {
      case "mute":
        return html`<label>Length in minutes <input type="number" name="minutes" min="1" max="${MUTE_MAX_MINUTES}" value="60" required></label>
<div class="chips"><button type="button" class="chip" data-fill="minutes=10">10 min</button><button type="button" class="chip" data-fill="minutes=60">1 hour</button><button type="button" class="chip" data-fill="minutes=1440">24 hours</button></div>`;
      case "warn":
      case "ban": {
        if (!d.ladder) return DOWN;
        const types = d.ladder.types;
        const sel = html`<label>Disney category <select name="type">${types.map((t) => html`<option value="${t.type}">${t.type}</option>`)}</select></label>
<label>Level <input type="number" name="level" min="1" max="5" value="${d.ladder.suggested[types[0]!.type] ?? types[0]!.min}" required></label>
<p class="muted" data-preview></p>`;
        if (kind === "warn") return html`<input type="hidden" name="mode" value="ladder">${sel}`;
        const perm = ok(ctx, "player.ban.permanent");
        return html`<fieldset class="modes"><legend>Ban type</legend>
<label><input type="radio" name="mode" value="ladder" checked> Disney category</label>
<label><input type="radio" name="mode" value="custom"> Custom</label></fieldset>
<div data-mode="ladder">${sel}</div>
<div data-mode="custom"><label>Length <select name="hours">${[1, 12, 24, 72].map((h) => html`<option value="${h}">${h} hour${h === 1 ? "" : "s"}</option>`)}${perm ? html`<option value="permanent">Permanent</option>` : ""}</select></label>${ctx.staff.role === "moderator" ? html`<p class="muted">Moderators can ban for up to ${MOD_BAN_MAX_HOURS} hours.</p>` : ""}</div>`;
      }
      default:
        return html``;
    }
  }

  function form(kind: Kind, ctx: RouteCtx, d: FormData_): SafeHtml {
    const base = playerPath(d.swid);
    return html`<form method="post" action="${base}/${kind}" class="stack aform" data-kind="${kind}" data-name="${d.name}">
<input type="hidden" name="_csrf" value="${ctx.csrf}">
${d.report ? html`<input type="hidden" name="report" value="${d.report}">` : ""}
${fields(kind, ctx, d)}
${chips(kind)}
<label>Reason <textarea name="reason" rows="2" maxlength="500" required placeholder="Pick a template above, then add detail if needed"></textarea></label>
<p class="effect" data-effect></p>
<div class="row"><button type="submit">${TITLE[kind]}</button><button type="button" class="ghost" data-close>Cancel</button></div>
</form>`;
  }

  async function load(ctx: RouteCtx, swid: string, needLadder: boolean): Promise<{ ok: true; name: string; role: string } & { ladder: FormData_["ladder"] } | { ok: false; res: Response }> {
    const prof = await clients.callWebApi(ctx.actor, "players.view", "POST", "/player/profile", { swid });
    if (prof.ok && prof.status === 404) return { ok: false, res: noPlayer(ctx) };
    if (!prof.ok || prof.status !== 200) return { ok: false, res: htmlResponse(page({ title: "Player", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: DOWN }), 502) };
    const ladder = needLadder ? await actions.fetchLadder(ctx, swid) : null;
    return { ok: true, name: visible(prof.json.displayName || prof.json.username), role: prof.json.role, ladder };
  }

  return {
    /** GET /players/<swid>/<kind>: the form as a page. */
    async page(ctx: RouteCtx, swid: string, kind: Kind): Promise<Response> {
      const l = await load(ctx, swid, kind === "ban" || kind === "warn");
      if (!l.ok) return l.res;
      const rep = /^\d{1,9}$/.test(ctx.url.searchParams.get("report") ?? "") ? Number(ctx.url.searchParams.get("report")) : undefined;
      const d = { swid, name: l.name, ladder: l.ladder, report: rep };
      const body = html`${l.ladder ? ladderJson(ctx, l.ladder) : ""}<p><a href="${playerPath(swid)}">← ${l.name}</a></p>${form(kind, ctx, d)}`;
      return htmlResponse(page({ title: `${TITLE[kind]} ${l.name}`, staff: ctx.staff, csrf: ctx.csrf, active: "players", body }));
    },
    /** The dialogs for the player page: one per permitted kind. */
    async dialogs(ctx: RouteCtx, swid: string, name: string, kinds: Kind[]): Promise<SafeHtml> {
      if (!kinds.length) return html``;
      const ladder = kinds.includes("ban") || kinds.includes("warn") ? await actions.fetchLadder(ctx, swid) : null;
      const d = { swid, name, ladder };
      return html`${ladder ? ladderJson(ctx, ladder) : ""}${kinds.map((k) => html`<dialog id="dlg-${k}"><h2>${TITLE[k]} ${name}</h2>${form(k, ctx, d)}</dialog>`)}`;
    },
  };
}
export type Forms = ReturnType<typeof makeForms>;
export { KINDS, ACTION_OF, isKind, SWID };
