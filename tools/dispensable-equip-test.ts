// dispensable.equip carries the prop id as a LONG (the client's
// serialize(int) resolves to the long overload), so the server must read
// any integer width. Before, every dispensable equip (fishing rods,
// instruments, food) was dropped and the room never saw the held item.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY);
const clients: GameClient[] = [];
const join = async (swid: string, name: string) => { const c = new GameClient(api, gs.port, swid, name); clients.push(c); await c.connect(); return c; };

try {
  const watcher = await join("{deq-w}", "Watcher");
  const player = await join("{deq-p}", "Holder");
  await sleep(300);
  const heldBy = () => watcher.varsOf(player.myId).map((v) => v.con).filter((c) => typeof c === "string") as string[];

  for (const [label, put] of [
    ["LONG (what the client sends)", (w: SFSObjectWriter) => w.putLong("type", 9n)],
    ["INT", (w: SFSObjectWriter) => w.putInt("type", 9)],
  ] as const) {
    const before = heldBy().length;
    player.ext13("dispensable.equip", put(new SFSObjectWriter()));
    await sleep(400);
    const got = heldBy().slice(before);
    check(got.length === 1 && got[0]!.includes("FishingRod"), `${label}: the room sees the fishing rod (${JSON.stringify(got)})`);
  }

  // Ids that aren't props are still refused, and nothing is relayed.
  const before = heldBy().length;
  player.ext13("dispensable.equip", new SFSObjectWriter().putLong("type", 99999n));
  player.ext13("dispensable.equip", new SFSObjectWriter().putLong("type", 2n ** 62n));
  player.ext13("dispensable.equip", new SFSObjectWriter().putUtfString("type", "9"));
  await sleep(400);
  check(heldBy().length === before, "unknown ids and a string id are not relayed");
  check(!player.closed && !watcher.closed, "nobody was disconnected");
} finally {
  for (const c of clients) c.sock?.destroy();
  gs.stop?.();
  api.stop();
}
finish();
