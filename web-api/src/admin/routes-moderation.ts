// Moderation actions for the panel: mute, warn, ban (timed and permanent)
// and lifting. The signed action picks the route; each route then applies
// the rules that hold even if the panel is bypassed:
// - rank: only targets whose game role is below the actor's panel rank;
// - self: never the actor's own linked account (actorSwid, required in
//   every body: the actor's linked swid or null);
// - ladder levels must be valid (not clamped), and the outcome decides the
//   route (warning → /warn, timed ban → /ban, open-ended → /ban/permanent);
// - moderators' timed bans are capped (MOD_BAN_MAX_HOURS);
// - a second ban within 10 s is refused as a duplicate (double taps);
// - lifting a ban someone else set needs ban.lift.any.
import { badRequest as bad, type Reply } from "../../../admin-panel/shared/listener.ts";
import { can, IN_GAME_ROLE } from "../../../admin-panel/shared/permissions.ts";
import { outranks, MOD_BAN_MAX_HOURS, MUTE_MAX_MINUTES } from "../../../admin-panel/shared/rank.ts";
import type { Actor } from "../../../admin-panel/shared/signing.ts";
import { int, isSwid, reason as reasonOf } from "./validate.ts";
import type { RouteTable, WebApiDeps } from "./routes.ts";

const DUPLICATE_MS = 10_000;
const MAX_CUSTOM_HOURS = 8760;
const by = (a: Actor) => `panel:${a.email}`;
const refuse = (status: number, error: string): Reply => ({ status, json: { error } });

type Target = { swid: string; reason: string };

/** Common checks; a Reply when the action can't go ahead. */
function target(body: any, d: WebApiDeps, actor: Actor): Target | Reply {
  if (!isSwid(body?.swid)) return bad("swid required");
  const reason = reasonOf(body?.reason);
  if (reason === undefined) return bad("a reason (1-500 characters) is required");
  const who = d.getPlayerIdentityAndRole(body.swid);
  if (!who) return refuse(404, "unknown player");
  // Fails closed: the panel must always say which account the actor is
  // linked to (null = none), so forgetting it can't skip the self rule.
  if (body.actorSwid !== null && !isSwid(body.actorSwid)) return bad("actorSwid (the actor's linked swid, or null) required");
  if (body.actorSwid !== null && body.actorSwid.toLowerCase() === body.swid.toLowerCase()) return refuse(403, "self");
  if (!outranks(actor.role, d.effectiveRole(who.username, who.role))) return refuse(403, "rank");
  return { swid: body.swid, reason };
}
const isReply = (t: Target | Reply): t is Reply => "status" in t;

type Outcome = { kind: "warn" } | { kind: "ban"; hours: number } | { kind: "permanent" };
type Plan = { outcome: Outcome; run: () => unknown };

/** What a ban/warn body would do, without doing it. */
function plan(body: any, d: WebApiDeps, actor: Actor, t: Target): Plan | Reply {
  if (body.mode === "ladder" || body.mode === undefined) {
    if (!d.mod.isAlertType(body.type)) return bad("unknown type");
    const o = d.mod.ladderOutcome(body.type, body.level);
    if (!o.valid) return bad("level not valid for this type");
    const outcome: Outcome = o.rung === null ? { kind: "warn" } : o.rung.kind === "lock" || o.rung.hours === null ? { kind: "permanent" } : { kind: "ban", hours: o.rung.hours };
    return { outcome, run: () => d.mod.sanction(t.swid, body.type, body.level, by(actor), t.reason) };
  }
  if (body.mode === "custom") {
    const hours = body.hours === null ? null : int(body.hours, 1, MAX_CUSTOM_HOURS);
    if (hours === undefined) return bad(`hours must be 1-${MAX_CUSTOM_HOURS} or null`);
    return { outcome: hours === null ? { kind: "permanent" } : { kind: "ban", hours }, run: () => ({ ban: d.mod.banFor(t.swid, hours, by(actor), t.reason) }) };
  }
  return bad("mode must be ladder or custom");
}

const ROUTE_FOR: Record<Outcome["kind"], string> = { warn: "use /warn", ban: "use /ban", permanent: "use /ban/permanent" };

function banRoute(kind: "ban" | "permanent") {
  return (body: any, d: WebApiDeps, actor: Actor): Reply => {
    const t = target(body, d, actor);
    if (isReply(t)) return t;
    const p = plan(body, d, actor, t);
    if ("status" in p) return p;
    if (p.outcome.kind !== kind) return refuse(409, ROUTE_FOR[p.outcome.kind]);
    if (p.outcome.kind === "ban" && actor.role === "moderator" && p.outcome.hours > MOD_BAN_MAX_HOURS) return refuse(403, "cap");
    const newest = d.mod.activeBans(t.swid)[0];
    if (newest && Date.now() - Date.parse(newest.created_at.replace(" ", "T") + "Z") < DUPLICATE_MS) return refuse(409, "duplicate");
    const r = p.run() as { ban: unknown };
    return { status: 200, json: { ban: r.ban } };
  };
}

export const moderationRoutes: RouteTable = {
  // The ladder as data (types, minimum level, what each level does) for the
  // panel's ban form; with a swid, also the suggested next level per type.
  "/ladder": {
    method: "POST", action: "players.view",
    run(body, d) {
      if (body?.swid !== undefined && !isSwid(body.swid)) return bad("swid must be a brace-wrapped id");
      const types = Object.entries(d.mod.LADDER).map(([type, def]: [string, any]) => ({
        type, min: def.min,
        rungs: def.rungs.map((r: any, i: number) => ({
          level: i + 1,
          outcome: r === null ? "warn" : r.kind === "lock" ? "lock" : r.hours === null ? "permanent" : "ban",
          hours: r?.hours ?? null,
        })),
      }));
      const json: any = { types };
      if (body?.swid !== undefined) json.suggested = Object.fromEntries(types.map((t) => [t.type, d.mod.suggestLevel(body.swid, t.type)]));
      return { status: 200, json };
    },
  },

  "/mute": {
    method: "POST", action: "player.mute",
    run(body, d, actor) {
      const t = target(body, d, actor);
      if (isReply(t)) return t;
      const minutes = int(body.minutes, 1, MUTE_MAX_MINUTES);
      if (minutes === undefined) return bad(`minutes must be 1-${MUTE_MAX_MINUTES}`);
      const row = d.mod.setMute(t.swid, minutes, by(actor), IN_GAME_ROLE[actor.role], t.reason);
      if (row === "rank") return refuse(403, "rank");
      return { status: 200, json: { until: row.until } };
    },
  },

  "/mute/lift": {
    method: "POST", action: "player.unmute",
    run(body, d, actor) {
      const t = target(body, d, actor);
      if (isReply(t)) return t;
      const r = d.mod.liftMute(t.swid, by(actor), IN_GAME_ROLE[actor.role]);
      if (r === "rank") return refuse(403, "rank");
      return { status: 200, json: { lifted: r === "lifted" } };
    },
  },

  "/warn": {
    method: "POST", action: "player.warn",
    run(body, d, actor) {
      const t = target(body, d, actor);
      if (isReply(t)) return t;
      const p = plan({ ...body, mode: "ladder" }, d, actor, t);
      if ("status" in p) return p;
      if (p.outcome.kind !== "warn") return refuse(409, ROUTE_FOR[p.outcome.kind]);
      const r = p.run() as { alertId: number; level: number };
      return { status: 200, json: { alertId: r.alertId, level: r.level } };
    },
  },

  "/ban": { method: "POST", action: "player.ban", run: banRoute("ban") },
  "/ban/permanent": { method: "POST", action: "player.ban.permanent", run: banRoute("permanent") },

  "/ban/lift": {
    method: "POST", action: "player.unban",
    run(body, d, actor) {
      const t = target(body, d, actor);
      if (isReply(t)) return t;
      const bans = d.mod.activeBans(t.swid);
      if (bans.length === 0) return { status: 200, json: { lifted: false } };
      if (bans.some((b) => b.set_by !== by(actor)) && !can(actor.role, actor.extras, "ban.lift.any")) return refuse(403, "not yours");
      return { status: 200, json: { lifted: d.mod.liftBan(t.swid, by(actor)) } };
    },
  },
};
