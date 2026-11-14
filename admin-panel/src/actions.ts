// The moderation flows: kick, mute, unmute, warn, ban, unban. Each runs the
// checks the listeners repeat (rank, self, caps, permanent), calls the web
// API (the saved state) and then the game server (the live effect), and
// writes exactly one audit row: ok, partial (saved, live effect missed),
// denied (refused here, nothing called) or failed.
import { can } from "../shared/permissions.ts";
import { outranks, MOD_BAN_MAX_HOURS, MUTE_MAX_MINUTES } from "../shared/rank.ts";
import { appendAudit } from "./audit.ts";
import type { Clients, CallResult } from "./clients.ts";
import type { DoneCode } from "./done.ts";
import type { RouteCtx } from "./pipeline.ts";
import type { Store } from "./store.ts";

export const KINDS = ["kick", "mute", "unmute", "warn", "ban", "unban"] as const;
export type Kind = (typeof KINDS)[number];
export const ACTION_OF: Record<Kind, string> = { kick: "player.kick", mute: "player.mute", unmute: "player.unmute", warn: "player.warn", ban: "player.ban", unban: "player.unban" };
export const isKind = (v: string): v is Kind => (KINDS as readonly string[]).includes(v);

export type ActionResult = { done: DoneCode; swid: string } | { error: string; status: number };

export interface LadderType { type: string; min: number; rungs: { level: number; outcome: "warn" | "ban" | "permanent" | "lock"; hours: number | null }[] }

const MAX_CUSTOM_HOURS = 8760;

type ListenerReply = Extract<CallResult, { ok: true }>;

function explain(r: CallResult, what: string): { error: string; status: number; result: "denied" | "failed"; detail: string } {
  if (!r.ok) return { error: `The ${what} isn't answering. Nothing was changed.`, status: 502, result: "failed", detail: "unreachable" };
  const e = typeof r.json?.error === "string" ? r.json.error : "";
  if (r.status === 400) return { error: `Refused: ${e || "bad request"}.`, status: 400, result: "failed", detail: e };
  if (r.status === 403) {
    const msg = e === "rank" ? "You can't act on a player of this rank." : e === "self" ? "You can't act on your own linked account." : e === "cap" ? `Moderators can ban for at most ${MOD_BAN_MAX_HOURS} hours.` : e === "not yours" ? "That ban was set by someone else; you can't lift it." : "Not allowed.";
    return { error: msg, status: 403, result: "denied", detail: e };
  }
  if (r.status === 404) return { error: "No such player.", status: 404, result: "failed", detail: e };
  if (r.status === 409) return { error: e === "duplicate" ? "That was already done a moment ago." : e.startsWith("use ") ? `That level doesn't work for this action (${e}).` : `Refused: ${e}.`, status: 409, result: "failed", detail: e };
  return { error: `The ${what} returned an error (${r.status}).`, status: 502, result: "failed", detail: `status ${r.status}` };
}

export function makeActions(clients: Clients, store: Store) {
  async function fetchLadder(ctx: RouteCtx, swid?: string): Promise<{ types: LadderType[]; suggested: Record<string, number> } | null> {
    const r = await clients.callWebApi(ctx.actor, "players.view", "POST", "/ladder", swid ? { swid } : {});
    return r.ok && r.status === 200 && Array.isArray(r.json?.types) ? { types: r.json.types, suggested: r.json.suggested ?? {} } : null;
  }

  async function runCore(kind: Kind, ctx: RouteCtx, swid: string, onOk: (reason: string) => Promise<void>): Promise<ActionResult> {
    const staff = ctx.staff, actor = ctx.actor, form = ctx.form!;
    const reason = String(form.get("reason") ?? "").trim();
    let action = ACTION_OF[kind];
    let params: Record<string, unknown> = {};
    const log = (result: "ok" | "partial" | "denied" | "failed", detail = "") => {
      if (result === "ok") onOk(reason).catch(() => {});
      try { appendAudit(store, { actor: staff.email, role: staff.role, action, target: swid, params, reason, result, detail }); }
      catch (err) { console.error(`[PANEL] audit write failed (${result} ${action}): ${(err as Error).message}`); }
    };
    const fail = (e: { error: string; status: number; result: "denied" | "failed"; detail: string }): ActionResult => { log(e.result, e.detail); return { error: e.error, status: e.status }; };
    const refuse = (error: string, status: number, result: "denied" | "failed", detail: string): ActionResult => fail({ error, status, result, detail });
    const actorSwid = staff.linkedSwid ?? null;
    const web = (act: string, path: string, body: Record<string, unknown>) => clients.callWebApi(actor, act, "POST", path, { swid, reason, actorSwid, ...body });
    const game = (act: string, path: string, body: Record<string, unknown> = {}) => clients.callGameServer(actor, act, "POST", path, { swid, actorSwid, ...body });
    const num = (k: string) => { const v = String(form.get(k) ?? "").trim(); return /^\d{1,6}$/.test(v) ? Number(v) : NaN; };

    const prof = await clients.callWebApi(actor, "players.view", "POST", "/player/profile", { swid });
    if (!prof.ok) return fail(explain(prof, "web API"));
    if (prof.status === 404) return refuse("No such player.", 404, "failed", "unknown player");
    if (prof.status !== 200) return fail(explain(prof, "web API"));
    if (actorSwid !== null && actorSwid.toLowerCase() === swid.toLowerCase()) return refuse("You can't act on your own linked account.", 403, "denied", "self");
    if (!outranks(staff.role, prof.json.role)) return refuse("You can't act on a player of this rank.", 403, "denied", "rank");

    switch (kind) {
      case "kick": {
        const r = await game("player.kick", "/kick");
        if (!r.ok || r.status !== 200) return fail(explain(r, "game server"));
        log("ok");
        return { done: r.json?.kicked > 0 ? "kicked" : "kicked-offline", swid };
      }
      case "mute": {
        const minutes = num("minutes");
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MUTE_MAX_MINUTES) return refuse(`Mute length is 1 to ${MUTE_MAX_MINUTES} minutes.`, 400, "failed", "minutes");
        params = { minutes };
        const w = await web("player.mute", "/mute", { minutes });
        if (!w.ok || w.status !== 200) return fail(explain(w, "web API"));
        const g = await game("player.mute", "/mute/apply", { until: w.json?.until });
        if (!g.ok || g.status !== 200) { log("partial", g.ok ? `game ${g.status}` : "game unreachable"); return { done: "muted-pending", swid }; }
        log("ok");
        return { done: "muted", swid };
      }
      case "unmute": {
        const w = await web("player.unmute", "/mute/lift", {});
        if (!w.ok || w.status !== 200) return fail(explain(w, "web API"));
        const g = await game("player.unmute", "/mute/clear");
        if (!g.ok || g.status !== 200) { log("partial", g.ok ? `game ${g.status}` : "game unreachable"); return { done: "unmuted-pending", swid }; }
        log("ok");
        return { done: "unmuted", swid };
      }
      case "unban": {
        const w = await web("player.unban", "/ban/lift", {});
        if (!w.ok || w.status !== 200) return fail(explain(w, "web API"));
        log("ok");
        return { done: "unbanned", swid };
      }
      case "warn":
      case "ban": {
        const mode = kind === "warn" ? "ladder" : String(form.get("mode") ?? "ladder");
        let body: Record<string, unknown>;
        let outcome: "warn" | "timed" | "permanent";
        let hours: number | null = null;
        if (mode === "ladder") {
          const type = String(form.get("type") ?? ""), level = num("level");
          const ladder = await fetchLadder(ctx);
          if (!ladder) return fail(explain({ ok: false, unreachable: true, detail: "" }, "web API"));
          const t = ladder.types.find((x) => x.type === type);
          if (!t) return refuse("Unknown category.", 400, "failed", "type");
          if (!Number.isInteger(level) || level < t.min || level > 5) return refuse(`${type} levels run from ${t.min} to 5.`, 400, "failed", "level");
          const rung = t.rungs[level - 1]!;
          outcome = rung.outcome === "warn" ? "warn" : rung.outcome === "ban" ? "timed" : "permanent";
          hours = rung.hours;
          params = { mode, type, level };
          body = { mode, type, level };
          if (kind === "warn" && outcome !== "warn") return refuse("That level isn't a warning: it bans. Use Ban.", 409, "failed", "not a warning");
          if (kind === "ban" && outcome === "warn") return refuse("That level is only a warning. Use Warn.", 409, "failed", "warning level");
        } else if (mode === "custom") {
          const h = String(form.get("hours") ?? "");
          if (h === "permanent") { outcome = "permanent"; hours = null; }
          else {
            const n = /^\d{1,6}$/.test(h) ? Number(h) : NaN;
            if (!Number.isInteger(n) || n < 1 || n > MAX_CUSTOM_HOURS) return refuse(`Ban hours are 1 to ${MAX_CUSTOM_HOURS}, or permanent.`, 400, "failed", "hours");
            outcome = "timed"; hours = n;
          }
          params = { mode, hours: hours ?? "permanent" };
          body = { mode, hours };
        } else return refuse("Unknown ban mode.", 400, "failed", "mode");

        if (outcome === "permanent") {
          action = "player.ban.permanent";
          if (!can(staff.role, staff.extras, action)) return refuse("Your role can't ban permanently.", 403, "denied", "not permitted");
        } else if (outcome === "timed" && staff.role === "moderator" && (hours ?? 0) > MOD_BAN_MAX_HOURS) {
          return refuse(`Moderators can ban for at most ${MOD_BAN_MAX_HOURS} hours.`, 403, "denied", "cap");
        }

        if (kind === "warn") {
          const w = await web("player.warn", "/warn", body);
          if (!w.ok || w.status !== 200) return fail(explain(w, "web API"));
          const g = await game("player.warn", "/notice", { key: "warned" });
          if (!g.ok || g.status !== 200) { log("partial", g.ok ? `game ${g.status}` : "game unreachable"); return { done: "warned", swid }; }
          log("ok");
          return { done: "warned", swid };
        }
        const w = await web(action, outcome === "permanent" ? "/ban/permanent" : "/ban", body);
        if (!w.ok || w.status !== 200) return fail(explain(w, "web API"));
        const g = await game("player.kick", "/kick");
        if (!g.ok || g.status !== 200) { log("partial", g.ok ? `game ${g.status}` : "game unreachable"); return { done: "banned-pending", swid }; }
        log("ok");
        return { done: "banned", swid };
      }
    }
  }

  // An action started from a report ("?report=<id>") resolves that report as
  // actioned, with the same reason, once the action went fully through.
  async function run(kind: Kind, ctx: RouteCtx, swid: string): Promise<ActionResult> {
    const raw = String(ctx.form?.get("report") ?? "");
    const id = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
    let pending: Promise<void> = Promise.resolve();
    const res = await runCore(kind, ctx, swid, (reason) => {
      if (!id) return Promise.resolve();
      pending = resolveReport(ctx, id, "actioned", reason, `with ${kind}`);
      return pending;
    });
    await pending;
    return res;
  }

  async function resolveReport(ctx: RouteCtx, id: number, status: "actioned" | "dismissed", reason: string, detail = ""): Promise<"ok" | "gone" | "closed" | "down"> {
    const r = await clients.callWebApi(ctx.actor, "reports.resolve", "POST", "/report/resolve", { id, status, reason });
    const result: "ok" | "failed" = r.ok && r.status === 200 ? "ok" : "failed";
    try { appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "reports.resolve", target: `report:${id}`, params: { status }, reason, result, detail: result === "ok" ? detail : (r.ok ? `status ${r.status} ${r.json?.error ?? ""}` : "unreachable") }); }
    catch (err) { console.error(`[PANEL] audit write failed (reports.resolve): ${(err as Error).message}`); }
    return !r.ok ? "down" : r.status === 200 ? "ok" : r.status === 404 ? "gone" : "closed";
  }

  return { run, fetchLadder, resolveReport };
}
export type Actions = ReturnType<typeof makeActions>;
