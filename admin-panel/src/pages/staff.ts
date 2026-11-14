// Staff page: the staff list for admins, edits for owners. Every change
// goes through a confirm page that states exactly what will happen, then
// saves, audits, and syncs the linked game account's role.
import { ACTIONS, isRole, type Role } from "../../shared/permissions.ts";
import type { Actor } from "../../shared/signing.ts";
import { appendAudit } from "../audit.ts";
import type { RouteCtx, RouteDef } from "../pipeline.ts";
import { htmlResponse } from "../pipeline.ts";
import { expectedGameRole, type RoleSync, type Resolved } from "../role-sync.ts";
import { normEmail, type Store, type StaffRow } from "../store.ts";
import { html, playerText, type SafeHtml } from "../web.ts";
import { page, errorPage } from "./layout.ts";

const ROLES: Role[] = ["moderator", "admin", "owner"];
// Extras a staff row may be granted: never an owner-minimum action.
const GRANTABLE = Object.values(ACTIONS).filter((a) => a.minRole !== "owner").map((a) => a.action);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Refusal extends Error {}
const refuse = (msg: string): never => { throw new Refusal(msg); };

interface Proposed {
  op: "add" | "update" | "disable" | "enable" | "sync";
  email: string;
  before: StaffRow | null;
  after: { role: Role; extras: string[]; linkedSwid: string | null; disabled: boolean };
  link: Resolved | null; // the new link, resolved
  oldLink: Resolved | null; // the previous link when it changes
}

function hidden(form: FormData): SafeHtml[] {
  const out: SafeHtml[] = [];
  for (const [k, v] of form.entries()) if (k !== "_csrf" && k !== "confirm" && k !== "rev" && typeof v === "string") out.push(html`<input type="hidden" name="${k}" value="${v}">`);
  return out;
}

// The row's revision when the confirm page was shown; a confirm whose
// revision no longer matches came from a stale page.
const revision = (row: StaffRow | null) => (row ? String(row.updatedAt) : "new");

const linkName = (r: Resolved | null, swid: string | null) => (r && r.ok ? playerText(r.username) : playerText(swid ?? "none"));

function describe(p: Proposed): SafeHtml {
  const game = p.link && p.link.ok ? html`; in-game role of ${playerText(p.link.username)} → <b>${p.after.disabled ? "player" : expectedGameRole({ ...p.before!, ...p.after, isConfigOwner: false } as StaffRow)}</b>` : html``;
  const old = p.oldLink && p.oldLink.ok ? html`; old account ${playerText(p.oldLink.username)} → <b>player</b> and unlocked` : html``;
  switch (p.op) {
    case "add":
      return html`Add <b>${p.email}</b> as <b>${p.after.role}</b> (extras: ${p.after.extras.join(", ") || "none"}); link ${linkName(p.link, p.after.linkedSwid)}${game}.`;
    case "update": {
      const b = p.before!;
      return html`Change <b>${p.email}</b>: role ${b.role} → <b>${p.after.role}</b>; extras ${b.extras.join(", ") || "none"} → <b>${p.after.extras.join(", ") || "none"}</b>; link ${linkName(p.oldLink ?? null, b.linkedSwid)} → <b>${linkName(p.link, p.after.linkedSwid)}</b>${game}${old}.`;
    }
    case "disable": return html`Disable <b>${p.email}</b> (they lose panel access)${game}.`;
    case "enable": return html`Enable <b>${p.email}</b> again${game}.`;
    case "sync": return html`Re-apply <b>${p.email}</b>'s role to their game account${game}.`;
  }
}

export function staffRoutes(store: Store, sync: RoleSync): Record<string, RouteDef> {
  async function resolveLink(actor: Actor, raw: string): Promise<Resolved | null> {
    const q = raw.trim();
    if (!q) return null;
    const r = await sync.resolve(actor, q);
    if (!r.ok) refuse(r.notFound ? `No game account "${q}".` : `Couldn't look up the game account: ${r.detail}`);
    return r;
  }

  async function propose(op: Proposed["op"], ctx: RouteCtx): Promise<Proposed> {
    const f = ctx.form!;
    const email = normEmail(String(f.get("email") ?? ""));
    if (!EMAIL.test(email) || email.length > 254) refuse("Enter a valid email.");
    const before = store.getStaff(email);
    const self = email === ctx.staff.email;

    if (op === "add") {
      if (before) refuse(`${email} is already staff; change their row instead.`);
    } else if (!before) refuse(`${email} is not staff.`);

    let role: Role = before?.role ?? "moderator";
    let extras = before?.extras ?? [];
    let linkedSwid = before?.linkedSwid ?? null;
    let disabled = before?.disabled ?? false;
    let link: Resolved | null = null, oldLink: Resolved | null = null;

    if (op === "add" || op === "update") {
      const r = String(f.get("role") ?? "");
      if (!isRole(r)) refuse("Pick a role.");
      role = r as Role;
      extras = [...new Set(f.getAll("extras").map(String))].sort();
      for (const x of extras) if (!GRANTABLE.includes(x)) refuse(`"${x}" can't be granted as an extra.`);
      if (before?.isConfigOwner && role !== "owner") refuse(`${email} is in PANEL_OWNERS; change that in the panel's env file.`);
      if (self && role !== before!.role) refuse("You can't change your own role.");
      if (before?.isConfigOwner) extras = [];
      link = await resolveLink(ctx.actor, String(f.get("link") ?? ""));
      linkedSwid = link && link.ok ? link.swid : null;
      const holder = linkedSwid ? store.listStaff().find((r) => r.email !== email && r.linkedSwid === linkedSwid) : undefined;
      if (holder) refuse(`That game account is already linked to ${holder.email}. One game account, one staff row.`);
      if (before?.linkedSwid && before.linkedSwid !== linkedSwid) {
        const o = await sync.resolve(ctx.actor, before.linkedSwid);
        oldLink = o.ok ? o : null;
      }
    } else if (op === "disable") {
      if (self) refuse("You can't disable yourself.");
      if (before!.isConfigOwner) refuse(`${email} is in PANEL_OWNERS; remove them there.`);
      disabled = true;
    } else if (op === "enable") {
      disabled = false;
    }
    if ((op === "disable" || op === "enable" || op === "sync") && linkedSwid) {
      const r = await sync.resolve(ctx.actor, linkedSwid);
      link = r.ok ? r : null;
    }
    return { op, email, before, after: { role, extras, linkedSwid, disabled }, link, oldLink };
  }

  async function listing(ctx: RouteCtx, banner?: SafeHtml): Promise<SafeHtml> {
    const owner = ctx.staff.role === "owner";
    const rows = store.listStaff();
    const resolved = await Promise.all(rows.map((r) => (r.linkedSwid ? sync.resolve(ctx.actor, r.linkedSwid) : Promise.resolve(null))));
    const tokens = html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
    const roleSelect = (cur: Role) => html`<select name="role">${ROLES.map((r) => html`<option value="${r}"${r === cur ? html` selected` : html``}>${r}</option>`)}</select>`;
    const extrasBoxes = (cur: string[]) => GRANTABLE.map((x) => html`<label><input type="checkbox" name="extras" value="${x}"${cur.includes(x) ? html` checked` : html``}> ${x}</label> `);

    const body = rows.map((r, i) => {
      const res = resolved[i];
      let state: SafeHtml;
      if (!r.linkedSwid) state = html`no link`;
      else if (!res || !res.ok) state = html`<span class="error">${res && res.notFound ? "game account missing" : "unknown (web API down)"}</span>`;
      else if (res.configAdmin && expectedGameRole(r) !== "admin") state = html`<span class="warn">STAFF_ADMINS conflict: always admin in game</span>`;
      else state = res.role === expectedGameRole(r) ? html`ok` : html`<span class="warn">out of sync</span>`;
      const account = r.linkedSwid ? (res && res.ok ? playerText(res.username) : playerText(r.linkedSwid)) : html`<span class="muted">none</span>`;
      const inGame = res && res.ok ? playerText(res.role) : html`<span class="muted">-</span>`;
      const actions = owner ? html`
<form method="post" action="/staff/update">${tokens}<input type="hidden" name="email" value="${r.email}">${roleSelect(r.role)} ${extrasBoxes(r.extras)}
<input name="link" value="${res && res.ok ? res.username : r.linkedSwid ?? ""}" placeholder="game username or {swid}"> <button>Change…</button></form>
<form method="post" action="/staff/${r.disabled ? "enable" : "disable"}">${tokens}<input type="hidden" name="email" value="${r.email}"><button>${r.disabled ? "Enable…" : "Disable…"}</button></form>
${r.linkedSwid ? html`<form method="post" action="/staff/sync">${tokens}<input type="hidden" name="email" value="${r.email}"><button>Sync role…</button></form>` : html``}` : html``;
      return html`<tr><td>${r.email}${r.isConfigOwner ? html` <span class="muted">(PANEL_OWNERS)</span>` : html``}${r.disabled ? html` <span class="error">disabled</span>` : html``}</td>
<td>${r.role}</td><td>${r.extras.join(", ") || html`<span class="muted">none</span>`}</td><td>${account}</td><td>${inGame}</td><td>${state}</td>${owner ? html`<td>${actions}</td>` : html``}</tr>`;
    });

    const add = owner ? html`<h2>Add staff</h2><form method="post" action="/staff/add">${tokens}
<input name="email" type="email" placeholder="email they sign in with" required> ${roleSelect("moderator")} ${extrasBoxes([])}
<input name="link" placeholder="game username or {swid} (optional)"> <button>Add…</button></form>` : html``;
    return page({
      title: "Staff", staff: ctx.staff, csrf: ctx.csrf,
      body: html`${banner ?? html``}<table><thead><tr><th>Email</th><th>Panel role</th><th>Extras</th><th>Game account</th><th>In-game role</th><th>Sync</th>${owner ? html`<th>Actions</th>` : html``}</tr></thead><tbody>${body}</tbody></table>${add}`,
    });
  }

  function confirmPage(ctx: RouteCtx, p: Proposed): SafeHtml {
    return page({
      title: "Confirm", staff: ctx.staff, csrf: ctx.csrf,
      body: html`<p>${describe(p)}</p><form method="post" action="${ctx.url.pathname}"><input type="hidden" name="_csrf" value="${ctx.csrf}">${hidden(ctx.form!)}
<input type="hidden" name="rev" value="${revision(p.before)}"><input type="hidden" name="confirm" value="1"><button>Confirm</button> <a href="/staff">Cancel</a></form>`,
    });
  }

  function change(op: Proposed["op"], action: "staff.edit" | "role.sync"): RouteDef {
    return {
      action, method: "POST",
      async run(ctx) {
        let p: Proposed;
        try { p = await propose(op, ctx); } catch (err) {
          if (err instanceof Refusal) return htmlResponse(errorPage(400, err.message), 400);
          throw err;
        }
        if (ctx.form!.get("confirm") !== "1") return confirmPage(ctx, p);
        if (ctx.form!.get("rev") !== revision(p.before)) {
          return htmlResponse(errorPage(409, "This staff row changed since you opened the confirm page (another owner may have edited it). Go back to Staff and try again."), 409);
        }

        if (op !== "sync") {
          if (op === "disable" || op === "enable") store.setDisabled(ctx.staff.email, p.email, p.after.disabled);
          else store.upsertStaff(ctx.staff.email, { email: p.email, role: p.after.role, extras: p.after.extras, linkedSwid: p.after.linkedSwid });
          const after = store.getStaff(p.email)!;
          appendAudit(store, {
            actor: ctx.staff.email, role: ctx.staff.role, action: "staff.edit", target: p.email,
            params: { op, before: p.before && { role: p.before.role, extras: p.before.extras, link: p.before.linkedSwid, disabled: p.before.disabled }, after: { role: after.role, extras: after.extras, link: after.linkedSwid, disabled: after.disabled } },
            reason: null, result: "ok", detail: null,
          });
        }
        const row = store.getStaff(p.email)!;
        const needsSync = row.linkedSwid || (p.before?.linkedSwid && p.before.linkedSwid !== row.linkedSwid);
        let banner = html`<p class="muted">Saved.</p>`;
        if (needsSync) {
          const r = await sync.syncRole(ctx.actor, row, p.before?.linkedSwid ?? null);
          banner = r.ok ? html`<p class="muted">Saved and synced to the game.</p>` : html`<p class="warn">Saved, but the game account is out of sync (${r.step}): ${r.detail}</p>`;
        }
        return listing(ctx, banner);
      },
    };
  }

  return {
    "GET /staff": { action: "staff.view", method: "GET", run: (ctx) => listing(ctx) },
    "POST /staff/add": change("add", "staff.edit"),
    "POST /staff/update": change("update", "staff.edit"),
    "POST /staff/disable": change("disable", "staff.edit"),
    "POST /staff/enable": change("enable", "staff.edit"),
    "POST /staff/sync": change("sync", "role.sync"),
  };
}


