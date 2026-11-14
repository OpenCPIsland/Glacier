import type { Session } from "./session.ts";
import { ROLE_LEVEL, type Role } from "./commands/roles.ts";

// Chat mutes. The web API saves them (moderation_mutes); this is the game
// server's cache of the active ones, keyed by the signed swid, which is
// known as soon as a player logs in. It's filled at login (account.ts),
// refreshed for everyone online by the periodic recheck (ban-watch.ts), and
// updated at once by :mute / :unmute and the admin listener. setBy is the
// rank that set it when known; the web API has the final say on lifting.
interface Mute {
  accountName: string;
  until: number;
  setBy: Role | undefined;
  // Set while the web API couldn't save it: the recheck doesn't drop it.
  local: boolean;
}
const mutes = new Map<string, Mute>();

export function cacheMute(swid: string, accountName: string, until: number, setBy: Role | undefined, local = false): void {
  mutes.set(swid, { accountName, until, setBy, local });
}

export function clearMute(swid: string): void {
  mutes.delete(swid);
}

/** Kept for callers of the old in-memory API. */
export const unmute = clearMute;

/**
 * Brings the cache in line with the web API for the players online:
 * listed swids are muted until the given time, online swids not listed
 * aren't muted. Offline entries, and mutes the web API couldn't save,
 * are left to expire.
 */
export function replaceFromState(online: { swid: string; accountName: string }[], state: Record<string, string>): void {
  for (const { swid, accountName } of online) {
    applySaved(swid, accountName, Object.hasOwn(state, swid) ? Date.parse(state[swid]!) : null);
  }
}

/**
 * The web API's answer for one player (until ms, or null for no saved
 * mute) applied to the cache. A mute it couldn't save stays until it
 * expires, unless the saved one runs longer.
 */
export function applySaved(swid: string, accountName: string, until: number | null): void {
  const known = live(swid);
  if (until === null || !Number.isFinite(until) || until <= Date.now()) {
    if (!known?.local) mutes.delete(swid);
    return;
  }
  if (known?.local && known.until > until) return;
  mutes.set(swid, { accountName, until, setBy: known && known.until === until ? known.setBy : undefined, local: false });
}

/** The cached mute for a swid, if active. */
export function muteOf(swid: string): Mute | undefined {
  return live(swid);
}

function live(swid: string): Mute | undefined {
  const entry = mutes.get(swid);
  if (entry && entry.until <= Date.now()) {
    mutes.delete(swid);
    return undefined;
  }
  return entry;
}

/** When the session's mute ends (ms), or undefined if it isn't muted. */
export function mutedUntil(session: Session): number | undefined {
  return session.swid ? live(session.swid)?.until : undefined;
}

/**
 * The mute for an account name, matched exactly, else the only mute whose
 * name matches ignoring case. Works for players who are offline.
 */
export function findMute(accountName: string): { swid: string; mute: Mute } | undefined {
  const all = [...mutes.keys()].map((swid) => ({ swid, mute: live(swid) })).filter((m): m is { swid: string; mute: Mute } => !!m.mute);
  const exact = all.find((m) => m.mute.accountName === accountName);
  if (exact) return exact;
  const loose = all.filter((m) => m.mute.accountName.toLowerCase() === accountName.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

/** Local check, used only when the web API can't be asked. Unknown setter = admin. */
export function canLift(m: Mute, by: Role): boolean {
  return ROLE_LEVEL[by] >= ROLE_LEVEL[m.setBy ?? "admin"];
}
