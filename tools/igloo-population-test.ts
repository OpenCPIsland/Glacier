// Igloo lists show who is inside: the populations endpoint (friends list)
// gives each igloo's scale, and /igloo/v1/igloos/popular lists public igloos
// with someone inside, busiest first. Private and friends-only igloos are
// not listed there.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY);
const clients: GameClient[] = [];

try {
  const viewer = new GameClient(api, gs.port, "{igp-v}", "Viewer");
  clients.push(viewer);
  await viewer.connect();
  const call = async (c: GameClient, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${api.base}${path}`, { method, headers: c.auth(), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  // An igloo owner, and a visitor inside their igloo.
  const owner = new GameClient(api, gs.port, "{igp-o}", "IglooOwner");
  clients.push(owner);
  await owner.connect();
  const setVisibility = (v: number) => call(owner, "PUT", "/igloo/v1", { visibility: v });
  const enter = async (who: GameClient) => {
    const r = await call(who, "POST", "/game/v1/igloos/language/en/players", { name: "DefaultIgloo", instanceId: owner.swid });
    check(r.status === 200, `${who.name} got join data for the igloo (${r.status})`);
    const text = JSON.stringify(r.json);
    who.sid = text.match(/"sessionId"\s*:\s*(\d+)/)![1]!;
    return r.json;
  };

  await setVisibility(2);
  const popular = async () => (await call(viewer, "GET", "/igloo/v1/igloos/popular?language=en")).json as any[];
  const zones = [{ name: "DefaultIgloo", instanceId: owner.swid }, { name: "DefaultIgloo", instanceId: "{nobody}" }];
  const scale = async () => ((await call(viewer, "POST", "/igloo/v1/igloos/populations/zoneIds?language=en", zones)).json as any[]).map((p) => p.populationScaled);

  check(JSON.stringify(await popular()) === "[]", "no public igloo is listed while nobody is inside");
  check(JSON.stringify(await scale()) === '[0,0]', "empty igloos have population 0 (ZERO)");

  // The visitor logs in to the game server as the real client does.
  const visitorJoin = await call(viewer, "POST", "/game/v1/igloos/language/en/players", { name: "DefaultIgloo", instanceId: owner.swid });
  check(visitorJoin.status === 200, "the viewer got join data for the owner's igloo");
  check(JSON.stringify(await scale()) === '[1,0]', "a fresh join inside the igloo counts: 1 (ONE)");
  const list = await popular();
  check(list.length === 1 && list[0].iglooPopulation === 1, `the public igloo is listed with its population (${JSON.stringify(list.map((l) => l.iglooPopulation))})`);
  check(list[0]?.ownerData?.id?.id === owner.swid && list[0]?.ownerData?.name, "with its owner's player data");

  await setVisibility(1);
  check(JSON.stringify(await popular()) === "[]", "a friends-only igloo is not listed");
  check(JSON.stringify(await scale()) === '[0,0]', "and a stranger isn't told who is inside it");
  await setVisibility(0);
  check(JSON.stringify(await popular()) === "[]", "a private igloo is not listed");
  check(JSON.stringify(await scale()) === '[0,0]', "and a stranger isn't told who is inside it either");
  const ownScale = ((await call(owner, "POST", "/igloo/v1/igloos/populations/zoneIds?language=en", zones)).json as any[]).map((p) => p.populationScaled);
  check(ownScale[0] === 1, `the owner still sees their own igloo's population (${ownScale[0]})`);
  // A friend of the owner sees a friends-only igloo's population.
  const { Database: Db } = await import("bun:sqlite");
  const fd = new Db(api.dbPath);
  fd.run("INSERT INTO mix_friendships (swid, friend_user_id, is_trusted) VALUES (?, ?, 0), (?, ?, 0)", [owner.swid, viewer.swid, viewer.swid, owner.swid]);
  fd.close();
  await setVisibility(1);
  check(JSON.stringify(await scale()) === '[1,0]', "a friend of the owner sees a friends-only igloo's population");
  await setVisibility(2);
  check((await popular()).length === 1, "public again: listed again");
  check(JSON.stringify(await scale()) === '[1,0]', "and its population is shown again");

  // A join that never logs in stops counting.
  const { Database } = await import("bun:sqlite");
  const d = new Database(api.dbPath);
  d.run("UPDATE player_sessions SET created_at = datetime('now', '-2 minutes') WHERE world = 'Igloo'");
  d.close();
  check(JSON.stringify(await popular()) === "[]" && JSON.stringify(await scale()) === '[0,0]', "an igloo join that never connected stops counting");

  const bad = await call(viewer, "POST", "/igloo/v1/igloos/populations/zoneIds?language=en", "nonsense");
  check(bad.status === 400, `a malformed populations body is refused as a bad request (${bad.status})`);
  const odd = await call(viewer, "POST", "/igloo/v1/igloos/populations/zoneIds?language=en", [{ name: "DefaultIgloo", instanceId: { x: 1 } }, 5, null]);
  check(odd.status === 200 && odd.json.length === 3 && odd.json.every((p: any) => p.populationScaled === 0), `odd zone entries get a ZERO answer each, in place (${odd.status} ${JSON.stringify(odd.json?.map?.((p: any) => p.populationScaled))})`);
} finally {
  for (const c of clients) c.sock?.destroy();
  gs.stop?.();
  api.stop();
}
finish();
