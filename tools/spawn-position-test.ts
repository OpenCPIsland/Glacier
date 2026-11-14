// A player is shown to the room at the position the client spawned at, not at
// 0,0,0. The client sends its spawn position as its first l.a after joining,
// so the server waits for that (PlayerSpawnPositionManager.cs) before it
// announces the joiner, and shows a late arrival each occupant's last position.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY);
const move = (c: GameClient, p: number[]) => c.ext13("l.a", new SFSObjectWriter().putFloatArray("p", p).putByte("a", 0));
const near = (a: number[] | undefined, b: number[]) => !!a && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]!) < 0.01);

try {
  const a = new GameClient(api, sfs.port, "{sp-a}", "SpawnAlpha");
  await a.connect(); await sleep(200);
  move(a, [10, 2, 30]); await sleep(200);

  const b = new GameClient(api, sfs.port, "{sp-b}", "SpawnBravo");
  await b.connect(); await sleep(300);
  const seenA = b.added.find((x) => x.id === a.myId);
  check(near(seenA?.pos, [10, 2, 30]), `a late joiner sees an occupant where it last moved (${JSON.stringify(seenA?.pos)})`);

  // B has not sent its spawn position yet, so A must not be told B is at 0,0,0.
  check(!a.added.some((x) => x.id === b.myId && near(x.pos, [0, 0, 0])), "the room is not told the joiner is at 0,0,0");
  move(b, [-5, 1, 7]); await sleep(300);
  const seenB = a.added.find((x) => x.id === b.myId);
  check(near(seenB?.pos, [-5, 1, 7]), `the joiner is announced at its spawn position (${JSON.stringify(seenB?.pos)})`);
  check(a.added.filter((x) => x.id === b.myId).length === 1, "the joiner is announced once");
  move(b, [-4, 1, 7]); await sleep(200);
  check(a.added.filter((x) => x.id === b.myId).length === 1, "later moves don't announce it again");

  // A client that never sends a position is still shown, after a grace period.
  const c = new GameClient(api, sfs.port, "{sp-c}", "SpawnCharlie");
  await c.connect(); await sleep(4500);
  check(a.added.some((x) => x.id === c.myId), "a joiner that never moves is announced after the grace period");
} finally {
  sfs.stop(); api.stop();
}
finish();
