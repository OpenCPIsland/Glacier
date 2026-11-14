// The game server's admin routes, served by the shared signed listener on
// 127.0.0.1:8092. They act on live sessions only; what's saved (mutes,
// bans) lives in the web API and is changed through its listener first.
// Rules, checked here even though the panel checks them too:
// - rank from the live session.role (shared/rank.ts);
// - never the actor's own linked account: actorSwid (linked swid or null)
//   is required in every POST body, so leaving it out fails closed.
import { badRequest as bad, type Reply, type Route } from "../../../admin-panel/shared/listener.ts";
import { IN_GAME_ROLE } from "../../../admin-panel/shared/permissions.ts";
import { outranks, MUTE_MAX_MINUTES } from "../../../admin-panel/shared/rank.ts";
import type { Actor } from "../../../admin-panel/shared/signing.ts";

const GAME_ROLES = new Set(["player", "moderator", "admin"]);
const isSwid = (v: unknown): v is string => typeof v === "string" && /^\{[0-9A-Za-z-]{1,64}\}$/.test(v);

// Fixed texts the panel may send; it names one by key, never sends text.
export const NOTICES: Record<string, string> = Object.assign(Object.create(null), {
  warned: "A moderator has warned you. Please follow the rules.",
});

interface Session {
  signedLogin: boolean; accountName: string | undefined; role: string; swid: string | undefined;
  zoneName: string; roomName: string; connectedAt: number | undefined;
}
interface Registered { session: Session; send(packet: unknown): void; close(): void }

export interface GameDeps {
  getAll(): Registered[];
  mutedUntil(session: Session): number | undefined;
  muteOf(swid: string): { setBy: string | undefined } | undefined;
  cacheMute(swid: string, accountName: string, until: number, setBy: "moderator" | "admin"): void;
  clearMute(swid: string): void;
  disconnectPacket(reason: number): unknown;
  DISCONNECT_KICK: number;
  systemChatPacket(session: Session, text: string, error?: boolean): unknown;
}

const refuse = (status: number, error: string): Reply => ({ status, json: { error } });
const MUTE_RANK: Record<string, number> = Object.assign(Object.create(null), { player: 0, moderator: 1, admin: 2 });
// Slack for clock drift between the web API's until and this check.
const MUTE_MAX_MS = MUTE_MAX_MINUTES * 60_000 + 60_000;

export function gameRoutes(d: GameDeps): Record<string, Route> {
  const signedIn = () => d.getAll().filter((e) => e.session.signedLogin);

  /** The live sessions for body.swid after the checks, or a Reply. */
  function targets(body: any, actor: Actor): Registered[] | Reply {
    if (!isSwid(body?.swid)) return bad("swid required");
    if (body.actorSwid !== null && !isSwid(body.actorSwid)) return bad("actorSwid (the actor's linked swid, or null) required");
    if (body.actorSwid !== null && body.actorSwid.toLowerCase() === body.swid.toLowerCase()) return refuse(403, "self");
    const live = signedIn().filter((e) => e.session.swid === body.swid);
    if (live.some((e) => !outranks(actor.role, e.session.role))) return refuse(403, "rank");
    return live;
  }
  const isReply = (t: Registered[] | Reply): t is Reply => !Array.isArray(t);
  // A cached mute whose setter outranks the actor can't be replaced or
  // cleared from here (the web API applies the same rule to saved mutes).
  // Mutes learned from the web API have no known setter: the web API
  // already decided, and the next recheck restores a mute that's still saved.
  const lockedMute = (swid: string, actor: Actor) => {
    const m = d.muteOf(swid);
    return !!m?.setBy && (MUTE_RANK[m.setBy] ?? 2) > MUTE_RANK[IN_GAME_ROLE[actor.role]]!;
  };

  return {
    "/health": { method: "GET", action: "dashboard.view", run: () => ({ status: 200, json: { ok: true, online: signedIn().length } }) },

    // Same rule as changeRole in commands/role-admin.ts: only sessions
    // whose identity came from a signed login get a staff role.
    "/session-role": {
      method: "POST", action: "role.sync",
      run(body) {
        const { username, role } = body ?? {};
        if (typeof username !== "string" || !GAME_ROLES.has(role)) return bad("username and role (player|moderator|admin) required");
        // Exact match: accounts that differ only in case are different
        // accounts. The panel sends the canonical name from the web API.
        let updated = 0;
        for (const e of signedIn()) {
          if (e.session.accountName === username) { e.session.role = role; updated++; }
        }
        return { status: 200, json: { updated } };
      },
    },

    "/online": {
      method: "GET", action: "players.view",
      run: () => ({
        status: 200,
        json: {
          players: signedIn().filter((e) => e.session.swid).map(({ session: s }) => ({
            swid: s.swid, accountName: s.accountName ?? null, role: s.role, world: s.zoneName, room: s.roomName,
            connectedAt: s.connectedAt ?? null, mutedUntil: d.mutedUntil(s) ?? null,
          })),
        },
      }),
    },

    "/kick": {
      method: "POST", action: "player.kick",
      run(body, actor) {
        const t = targets(body, actor);
        if (isReply(t)) return t;
        for (const e of t) {
          try { e.send(d.disconnectPacket(d.DISCONNECT_KICK)); } catch { /* socket already gone */ }
          // Give the client a moment to read the reason before the socket goes.
          setTimeout(() => e.close(), 100);
        }
        return { status: 200, json: { kicked: t.length } };
      },
    },

    "/mute/apply": {
      method: "POST", action: "player.mute",
      run(body, actor) {
        const until = typeof body?.until === "string" ? Date.parse(body.until) : NaN;
        if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + MUTE_MAX_MS) return bad(`until must be a future ISO time, at most ${MUTE_MAX_MINUTES} minutes ahead`);
        const t = targets(body, actor);
        if (isReply(t)) return t;
        if (lockedMute(body.swid, actor)) return refuse(403, "rank");
        const minutes = Math.max(1, Math.round((until - Date.now()) / 60_000));
        for (const e of t) {
          d.cacheMute(body.swid, e.session.accountName ?? "", until, IN_GAME_ROLE[actor.role]);
          e.send(d.systemChatPacket(e.session, `You are muted for ${minutes} minute${minutes === 1 ? "" : "s"}`, true));
        }
        return { status: 200, json: { applied: t.length } };
      },
    },

    "/mute/clear": {
      method: "POST", action: "player.unmute",
      run(body, actor) {
        const t = targets(body, actor);
        if (isReply(t)) return t;
        if (lockedMute(body.swid, actor)) return refuse(403, "rank");
        d.clearMute(body.swid);
        return { status: 200, json: { cleared: t.length } };
      },
    },

    "/notice": {
      method: "POST", action: "player.warn",
      run(body, actor) {
        const text = typeof body?.key === "string" && Object.hasOwn(NOTICES, body.key) ? NOTICES[body.key]! : undefined;
        if (!text) return bad("unknown notice");
        const t = targets(body, actor);
        if (isReply(t)) return t;
        for (const e of t) e.send(d.systemChatPacket(e.session, text, true));
        return { status: 200, json: { sent: t.length } };
      },
    },
  };
}
