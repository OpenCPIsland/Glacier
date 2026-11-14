import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import { cacheMute, canLift, clearMute, findMute, muteOf } from "../mutes.ts";
import { saveMute, saveUnmute, type MuteRank } from "../webapi-client.ts";
import type { HandlerContext } from "../handlers/context.ts";
import type { RegisteredSession } from "../session-registry.ts";
import { ROLE_LEVEL } from "./roles.ts";
import { reply, replyError, resolveTarget, usage, type CommandDef } from "./common.ts";
import { systemChatPacket } from "./reply.ts";

// System action 1005, ClientDisconnection: both client APIs read "dr" as a
// byte index into (idle, kick, ban, ...) and disconnect with that reason.
export const DISCONNECT_IDLE = 0;
export const DISCONNECT_KICK = 1;
export function disconnectPacket(reason: number) {
  return encodePacket(0, 1005, new SFSObjectWriter().putByte("dr", reason));
}

/** The target, unless it's the caller or holds an equal or higher role (replies itself). */
function targetBelowCaller(ctx: HandlerContext, name: string, verb: string): RegisteredSession | undefined {
  const target = resolveTarget(ctx, name);
  if (!target) return undefined;
  if (target.session.userId === ctx.session.userId) {
    replyError(ctx, `You can't ${verb} yourself`);
    return undefined;
  }
  if (ROLE_LEVEL[target.session.role] >= ROLE_LEVEL[ctx.session.role]) {
    replyError(ctx, `You can't ${verb} ${target.session.accountName}`);
    return undefined;
  }
  return target;
}

const DEFAULT_MUTE_MINUTES = 10;
const UNSAVED = " (until the next restart only: couldn't save)";
const muteRank = (ctx: HandlerContext): MuteRank => (ctx.session.role === "admin" ? "admin" : "moderator");
const plural = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
const MAX_MUTE_MINUTES = 1440;

export const commands: CommandDef[] = [
  {
    name: "kick",
    minRole: "moderator",
    usage: ":kick <user>",
    run(args, ctx) {
      if (args.length !== 1) return usage(ctx, this);
      const target = targetBelowCaller(ctx, args[0]!, "kick");
      if (!target) return;
      target.send(disconnectPacket(DISCONNECT_KICK));
      // Give the client a moment to read the reason before the socket goes.
      setTimeout(() => target.close(), 100);
      reply(ctx, `Kicked ${target.session.accountName}`);
    },
  },
  {
    name: "mute",
    minRole: "moderator",
    usage: `:mute <user> [minutes 1-${MAX_MUTE_MINUTES}, default ${DEFAULT_MUTE_MINUTES}]`,
    async run(args, ctx) {
      if (args.length < 1 || args.length > 2) return usage(ctx, this);
      const minutes = args[1] === undefined ? DEFAULT_MUTE_MINUTES : /^\d+$/.test(args[1]) ? Number(args[1]) : NaN;
      if (!(minutes >= 1 && minutes <= MAX_MUTE_MINUTES)) return usage(ctx, this);
      const target = targetBelowCaller(ctx, args[0]!, "mute");
      if (!target) return;
      const swid = target.session.swid;
      const name = target.session.accountName!;
      if (!swid) return replyError(ctx, `Can't mute ${name}`);
      // Saved first, so a mute set by a higher rank can't be replaced (and
      // so cut short) from here. If it can't be saved, it still applies to
      // this session.
      const saved = await saveMute({ swid, minutes, setBy: `game:${ctx.session.accountName}`, setByRank: muteRank(ctx) });
      if (saved === "rank") return replyError(ctx, `${name} was muted by an admin`);
      // Unsaved: the local cache is all there is, so it applies the same
      // rule (a lower rank can't replace, and so shorten, a mute).
      const current = saved === "error" ? muteOf(swid) : undefined;
      if (current && !canLift(current, ctx.session.role)) return replyError(ctx, `${name} was muted by an admin`);
      if (saved === "error") cacheMute(swid, name, Date.now() + minutes * 60_000, ctx.session.role, true);
      else cacheMute(swid, name, saved.until, ctx.session.role);
      target.send(systemChatPacket(target.session, `You are muted for ${plural(minutes)}`, true));
      reply(ctx, `Muted ${name} for ${plural(minutes)}${saved === "error" ? UNSAVED : ""}`);
    },
  },
  {
    name: "unmute",
    minRole: "moderator",
    usage: ":unmute <user>",
    async run(args, ctx) {
      if (args.length !== 1) return usage(ctx, this);
      // Works for players who are offline too (while their mute is cached).
      const online = resolveTarget(ctx, args[0], { quiet: true });
      const found = online?.session.swid ? findMute(online.session.accountName!) : findMute(args[0]!);
      const name = found?.mute.accountName ?? online?.session.accountName ?? args[0]!;
      if (!found) return replyError(ctx, `${name} isn't muted`);
      if (found.swid === ctx.session.swid) return replyError(ctx, "You can't unmute yourself");
      // The web API decides who may lift a saved mute; the local rank is
      // only the fallback when it can't be asked.
      const saved = await saveUnmute({ swid: found.swid, by: `game:${ctx.session.accountName}`, byRank: muteRank(ctx) });
      if (saved === "rank") return replyError(ctx, `${name} was muted by an admin`);
      // "none" means the web API has nothing saved: what's cached is a mute
      // it couldn't save, so the local rule decides, as when it can't be asked.
      if (saved !== "lifted" && !canLift(found.mute, ctx.session.role)) {
        const by = found.mute.setBy ?? "admin";
        return replyError(ctx, `${name} was muted by ${by === "admin" ? "an" : "a"} ${by}`);
      }
      clearMute(found.swid);
      reply(ctx, `Unmuted ${name}${saved === "error" ? UNSAVED : ""}`);
    },
  },
];
