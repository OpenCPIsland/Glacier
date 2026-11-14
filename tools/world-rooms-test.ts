// Players in different worlds (the client's "servers") never share a room on
// the game server, and a world other than Alpine joins and connects like any
// other: the world is part of the signed room name the game server keys rooms by.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
process.env.JOIN_SIGNING_KEY = KEY;
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY);
const clients: GameClient[] = [];

try {
  const make = (n: number, world: string) => {
    const c = new GameClient(api, sfs.port, `{DDDD0000-0000-0000-0000-00000000000${n}}`, `Wld${n}`);
    c.world = world;
    clients.push(c);
    return c;
  };
  const a = make(1, "Iceberg"), b = make(2, "Iceberg"), c = make(3, "Blizzard"), d = make(4, "Alpine");
  for (const x of [a, b, c, d]) { await x.connect(); await sleep(200); }
  await sleep(300);

  const pushes = sfs.logs().split("\n").filter((l) => l.includes("join room push"));
  const inWorld = (w: string) => pushes.filter((l) => l.includes(`${w}:`));
  check(pushes.length === 4, `four joins reached the game server (${pushes.length})`);
  check(inWorld("Iceberg").length === 2 && /ul=0\)/.test(inWorld("Iceberg")[0] ?? "") && /ul=1\)/.test(inWorld("Iceberg")[1] ?? ""), `the second Iceberg player finds the first (${inWorld("Iceberg").map((l) => l.slice(-8)).join(" | ")})`);
  check(inWorld("Blizzard").length === 1 && /ul=0\)/.test(inWorld("Blizzard")[0] ?? ""), `the Blizzard player is alone (${inWorld("Blizzard")[0]?.slice(-8)})`);
  check(inWorld("Alpine").length === 1 && /ul=0\)/.test(inWorld("Alpine")[0] ?? ""), `the Alpine player is alone (${inWorld("Alpine")[0]?.slice(-8)})`);
} finally {
  for (const x of clients) try { x.sock?.destroy(); } catch {}
  sfs.stop();
  api.stop();
}
finish(api.logs());
