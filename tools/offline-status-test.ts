// A player who logs out stops having an online location, so other players'
// cards say "Offline" and not "Unreachable" (the card shows "Unreachable"
// whenever onlineLocation names a room the viewer can't jump to).
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { Database } from "bun:sqlite";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY);
const clients: GameClient[] = [];
const join = async (swid: string, name: string, room = "Town") => { const c = new GameClient(api, gs.port, swid, name, room); clients.push(c); await c.connect(); return c; };

try {
  const viewer = await join("{off-v}", "Viewer");
  const location = async (swid: string) => {
    const r = await fetch(`${api.base}/player/v1/id/${encodeURIComponent(swid)}`, { headers: viewer.auth() });
    return ((await r.json()) as any).onlineLocation;
  };
  const waitOffline = async (swid: string) => { for (let i = 0; i < 30 && (await location(swid)) !== null; i++) await sleep(100); return location(swid); };

  const a = await join("{off-a}", "PlayerA");
  check((await location("{off-a}"))?.room === "Town", "online in Town while connected");
  a.sock.destroy();
  check((await waitOffline("{off-a}")) === null, "offline after a plain disconnect");

  // Moving rooms: a new join, a new connection, the old one closed.
  const b1 = await join("{off-b}", "PlayerB", "Town");
  const b2 = await join("{off-b}", "PlayerB", "Plaza");
  for (let i = 0; i < 30 && !b1.closed; i++) await sleep(100);
  check((await location("{off-b}"))?.room === "Plaza", "after a room change the player is in the new room");
  b2.sock.destroy();
  const left = await waitOffline("{off-b}");
  check(left === null, `offline after leaving from the second room (${JSON.stringify(left)})`);

  // A join that never logs in to the game server (a failed handshake, a
  // client that gave up) counts as online only for a short while.
  const ghost = new GameClient(api, gs.port, "{off-g}", "PlayerG");
  await createPlayer(api.base, api.dbPath, ghost.swid, ghost.name);
  const jr = await fetch(`${api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, { method: "POST", headers: ghost.auth(), body: "{}" });
  check(jr.ok, "(the ghost got join data)");
  check((await location("{off-g}"))?.room === "Town", "a fresh join counts as online while it connects");
  const db = new Database(api.dbPath);
  db.run("UPDATE player_sessions SET created_at = datetime('now', '-2 minutes') WHERE swid = '{off-g}'");
  db.close();
  check((await location("{off-g}")) === null, "a join that never logged in is offline after the grace period");

  // A game server restart forgets every session: no close was reported.
  const c = await join("{off-c}", "PlayerC");
  check((await location("{off-c}"))?.room === "Town", "online before the game server restarts");
  const reset = await fetch(`${api.base}/api/internal/sessions-reset`, { method: "POST", headers: api.internalHeaders(), body: "{}" });
  check(reset.ok, `sessions-reset -> ${reset.status}`);
  check((await location("{off-c}")) === null, "offline after sessions-reset");
  const noSecret = await fetch(`${api.base}/api/internal/sessions-reset`, { method: "POST", body: "{}" });
  check(noSecret.status === 403, `sessions-reset needs the internal secret (${noSecret.status})`);
} finally {
  for (const c of clients) c.sock?.destroy();
  gs.stop?.();
  api.stop();
}
finish();
