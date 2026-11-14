// The WebAPI counts a session as online until it's older than its 12 h
// window, and it only learns a session's time at join. So every few minutes
// this server reports the sessions it still has connected, keeping long
// sessions counted (room cap, friends' online status). A session that's gone
// without a reported close simply stops being refreshed and ages out.
import { SESSION_HEARTBEAT_MS } from "./config.ts";
import { getAll } from "./session-registry.ts";
import { reportSessionsAlive } from "./webapi-client.ts";

/** The WebAPI session ids of every signed, connected login. */
export function liveSessionIds(): number[] {
  const ids: number[] = [];
  for (const { session } of getAll()) {
    const id = Number(session.playerSessionId);
    if (session.signedLogin && Number.isSafeInteger(id)) ids.push(id);
  }
  return ids;
}

export function startSessionHeartbeat(): void {
  if (SESSION_HEARTBEAT_MS <= 0) return;
  setInterval(() => {
    const ids = liveSessionIds();
    // The WebAPI takes up to 10,000 ids per call.
    for (let i = 0; i < ids.length; i += 10_000) void reportSessionsAlive(ids.slice(i, i + 10_000));
  }, SESSION_HEARTBEAT_MS).unref();
}
