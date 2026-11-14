// Live sessions stay counted however long they last. A session's
// last_activity was only written at join, and the online rule drops rows
// older than 12 h, so a player connected that long stopped counting against
// the room cap (and showed offline) while still in the room. The game server
// now reports its live sessions periodically (POST /api/internal/sessions-alive),
// which refreshes them; a row it stops reporting still ages out.
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker, type WebApi } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const basic = (swid: string) => ({ Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json" });
const sql = (api: WebApi, q: string, ...p: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...p) as any[]; } finally { d.close(); } };
const join = (api: WebApi, swid: string) => fetch(`${api.base}/game/v1/worlds/Iceberg/language/en/rooms/Town/players`, { method: "POST", headers: basic(swid), body: "{}" });

const key = crypto.randomBytes(32).toString("hex");
const api = await startWebApi({ env: { ROOM_CAP: "1", ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: key } });
let gs: Awaited<ReturnType<typeof startGameServer>> | undefined;
try {
  // ---- the web API endpoint ----
  for (const s of ["{HB-P}", "{HB-Q}"]) await createPlayer(api.base, api.dbPath, s, s.replace(/\W/g, ""));
  const sid = Number((await (await join(api, "{HB-P}")).text()).match(/"sessionId"\s*:\s*(\d+)/)![1]);
  await fetch(`${api.base}/api/internal/session-started`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ sessionId: sid }) });
  sql(api, "UPDATE player_sessions SET last_activity = datetime('now', '-13 hours') WHERE session_id = ?", sid);
  const alive = await fetch(`${api.base}/api/internal/sessions-alive`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ sessionIds: [sid] }) });
  check(alive.status === 200, `sessions-alive answers 200 (${alive.status})`);
  const q = await join(api, "{HB-Q}");
  check(q.status === 409, `a 13-hour session reported alive still fills the room (${q.status})`);
  const noSecret = await fetch(`${api.base}/api/internal/sessions-alive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionIds: [sid] }) });
  check(noSecret.status === 403, `sessions-alive needs the internal secret (${noSecret.status})`);
  const bad = await fetch(`${api.base}/api/internal/sessions-alive`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ sessionIds: ["x"] }) });
  check(bad.status === 400, `non-integer session ids are refused (${bad.status})`);
  const tooMany = await fetch(`${api.base}/api/internal/sessions-alive`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ sessionIds: Array.from({ length: 10_001 }, (_, i) => i + 1) }) });
  check(tooMany.status === 400, `more than 10,000 ids are refused (${tooMany.status})`);

  // An unconfirmed join isn't refreshed: only live connections count.
  sql(api, "UPDATE player_sessions SET confirmed = 0, created_at = datetime('now', '-13 hours'), last_activity = datetime('now', '-13 hours') WHERE session_id = ?", sid);
  await fetch(`${api.base}/api/internal/sessions-alive`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ sessionIds: [sid] }) });
  const touched = sql(api, "SELECT last_activity > datetime('now', '-1 hour') AS fresh FROM player_sessions WHERE session_id = ?", sid)[0].fresh;
  check(touched === 0, "an unconfirmed join is not refreshed");
  sql(api, "DELETE FROM player_sessions");

  // ---- the game server reports its live sessions ----
  gs = await startGameServer(api, key, { SFS_SESSION_HEARTBEAT_MS: "300" });
  const c = new GameClient(api, gs.port, "{HB-LIVE}", "HbLive", "Town");
  c.world = "Iceberg";
  await c.connect();
  for (let i = 0; i < 20; i++) {
    if (sql(api, "SELECT confirmed FROM player_sessions WHERE session_id = ?", Number(c.sid))[0]?.confirmed === 1) break;
    await sleep(100);
  }
  sql(api, "UPDATE player_sessions SET last_activity = datetime('now', '-13 hours') WHERE session_id = ?", Number(c.sid));
  await sleep(1200);
  const fresh = sql(api, "SELECT last_activity > datetime('now', '-1 minute') AS fresh FROM player_sessions WHERE session_id = ?", Number(c.sid))[0]?.fresh;
  check(fresh === 1, "the game server's heartbeat refreshed a connected player's session");
} finally {
  gs?.stop();
  await api.stop();
}
finish(gs?.logs());
