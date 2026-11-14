// Room population cap (ROOM_CAP): population bars scaled to the cap, the
// join gate that refuses a full room or igloo with CP_ROOM_FULL, and the
// room-full retry routed to the first world with space. Each section runs
// its own throwaway web API, so one section's full rooms never leak into
// the next.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker, type WebApi } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { roomCap, populationScaleFor } from "../web-api/src/utils/roomCap.ts";
import lots from "../web-api/data/lots.json";

const { check, finish } = makeChecker();
const logs: string[] = [];

const basic = (swid: string) => ({ Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json" });
let playerNo = 0;
/** A new player on `api`; returns its swid. */
async function player(api: WebApi): Promise<string> {
  const swid = `{CAP-${process.pid}-${++playerNo}}`;
  await createPlayer(api.base, api.dbPath, swid, `Cap${playerNo}`);
  return swid;
}
function joinRoom(api: WebApi, swid: string, world = "Iceberg", room = "Town", headers: Record<string, string> = {}) {
  return fetch(`${api.base}/game/v1/worlds/${world}/language/en/rooms/${room}/players`, {
    method: "POST", headers: { ...basic(swid), ...headers }, body: "{}",
  });
}
function joinIgloo(api: WebApi, swid: string, lot: string, owner: string) {
  return fetch(`${api.base}/game/v1/igloos/language/en/players`, {
    method: "POST", headers: basic(swid), body: JSON.stringify({ name: lot, instanceId: owner }),
  });
}
/** Runs SQL on the test web API's database. */
function sql(api: WebApi, query: string, ...params: any[]): any[] {
  const d = new Database(api.dbPath);
  try { return d.query(query).all(...params) as any[]; } finally { d.close(); }
}
const usernameOf = (api: WebApi, swid: string) => sql(api, "SELECT username FROM player_identity WHERE swid = ?", swid)[0].username as string;
/** Status of a join, plus whether its body is exactly CP_ROOM_FULL. */
async function outcome(r: Response): Promise<string> {
  if (r.status !== 409) { await r.body?.cancel(); return String(r.status); }
  const body = await r.json().catch(() => null);
  return JSON.stringify(body) === JSON.stringify({ code: 1000 }) ? "full" : `409 ${JSON.stringify(body)}`;
}

// ---- Task 1: the cap setting and the population bars ----
{
  const at100 = [0, 1, 16, 17, 33, 34, 66, 67, 99, 100, 250].map((n) => populationScaleFor(n, 100));
  check(at100.join(",") === "0,1,1,2,2,3,3,4,4,5,5", `scale at cap 100 (${at100})`);
  check(populationScaleFor(29, 30) === 4 && populationScaleFor(30, 30) === 5, "FIVE exactly at cap 30");
  for (const bad of [undefined, "", "abc", "0", "-5", "2.5"]) {
    if (bad === undefined) delete process.env.ROOM_CAP; else process.env.ROOM_CAP = bad;
    check(roomCap() === 100, `ROOM_CAP=${JSON.stringify(bad)} falls back to 100`);
  }
  process.env.ROOM_CAP = "3";
  check(roomCap() === 3, "ROOM_CAP=3 is read");
  delete process.env.ROOM_CAP;

  const api = await startWebApi({ env: { ROOM_CAP: "3", ALLOW_SWID_AUTH: "1" } });
  try {
    const swids: string[] = [];
    for (let i = 0; i < 3; i++) { swids.push(await player(api)); await joinRoom(api, swids[i]!); }
    const pops: any = await (await fetch(`${api.base}/game/v1/roomPopulation/Iceberg`, { headers: basic(swids[0]!) })).json();
    const town = pops.roomPopulations.find((p: any) => p.identifier.zoneId.name === "Town");
    check(town?.populationScaled === 5, `3 players in Town at ROOM_CAP=3 shows FIVE (${town?.populationScaled})`);
  } finally {
    logs.push(api.logs());
    await api.stop();
  }
}

// ---- Task 2: the gate on room and igloo joins ----
{
  const env = { ROOM_CAP: "3", ALLOW_SWID_AUTH: "1" };
  const api = await startWebApi({ env });
  try {
    const [A, B, C, D] = [await player(api), await player(api), await player(api), await player(api)];
    const abc = [await outcome(await joinRoom(api, A)), await outcome(await joinRoom(api, B)), await outcome(await joinRoom(api, C))];
    check(abc.join() === "200,200,200", `three players fill Iceberg/Town at cap 3 (${abc})`);
    check(await outcome(await joinRoom(api, D)) === "full", "the 4th join is refused with 409 {code:1000}");
    check(sql(api, "SELECT COUNT(*) n FROM player_sessions WHERE swid = ?", D)[0].n === 0, "the refused join registered no session");
    check(await outcome(await joinRoom(api, A)) === "200", "a player already in the room can join it again");
    const dAgain = [await outcome(await joinRoom(api, D)), await outcome(await joinRoom(api, D))];
    check(dAgain.join() === "full,full", `retries stay refused (${dAgain})`);

    // One player joining twice takes one place, not two. (Review Focus 2)
    const [E, F, G, H] = [await player(api), await player(api), await player(api), await player(api)];
    await joinRoom(api, E, "Alpine"); await joinRoom(api, E, "Alpine");
    const efgh = [await outcome(await joinRoom(api, F, "Alpine")), await outcome(await joinRoom(api, G, "Alpine")), await outcome(await joinRoom(api, H, "Alpine"))];
    check(efgh.join() === "200,200,full", `a double join counts once: F, G in, H refused (${efgh})`);

    // Staff get past the cap.
    sql(api, "UPDATE players SET role = 'moderator' WHERE username = ?", usernameOf(api, D));
    check(await outcome(await joinRoom(api, D)) === "200", "a moderator joins the full room");
    const S = await player(api);
    await api.restart({ ...env, STAFF_ADMINS: usernameOf(api, S) });
    check(await outcome(await joinRoom(api, S)) === "200", "a STAFF_ADMINS admin joins the full room");

    // Joins that never connected stop counting after 60 s.
    const W = await player(api);
    check(await outcome(await joinRoom(api, W)) === "full", "Iceberg/Town is full before the old joins age out");
    sql(api, "UPDATE player_sessions SET confirmed = 0, created_at = datetime('now', '-61 seconds') WHERE swid IN (?, ?, ?)", A, B, C);
    check(await outcome(await joinRoom(api, W)) === "200", "unconfirmed joins over 60 s old free their places");

    // Rooms are per client version. (Review Focus 4)
    const X = await player(api);
    check(await outcome(await joinRoom(api, X)) === "full", "Iceberg/Town is full again for the default version");
    check(await outcome(await joinRoom(api, X, "Iceberg", "Town", { "X-CP-Client-Version": "1.14.0" })) === "200", "another client version's Town has room");

    // Igloos: capped per owner; the owner always gets in. (Review Focus 3)
    const lot = Object.keys(lots)[0]!;
    const [O, P] = [await player(api), await player(api)];
    for (const owner of [O, P]) sql(api, "INSERT OR REPLACE INTO igloo_data (username, visibility) VALUES (?, 2)", usernameOf(api, owner));
    const visitors = [await player(api), await player(api), await player(api), await player(api)];
    const igl = [];
    for (const v of visitors) igl.push(await outcome(await joinIgloo(api, v, lot, O)));
    check(igl.join() === "200,200,200,full", `O's igloo takes 3 visitors, refuses the 4th (${igl})`);
    check(await outcome(await joinIgloo(api, O, lot, O)) === "200", "the owner gets into their own full igloo");
    check(await outcome(await joinIgloo(api, D, lot, O)) === "200", "a moderator gets into a full igloo");
    check(await outcome(await joinIgloo(api, visitors[3]!, lot, P)) === "200", "another owner's igloo of the same lot has room");
  } finally {
    logs.push(api.logs());
    await api.stop();
  }
}

// ---- Task 3: the room-full retry goes to the first world with space ----
{
  const api = await startWebApi({ env: { ROOM_CAP: "3", ALLOW_SWID_AUTH: "1" } });
  try {
    const viewer = await player(api);
    const rooms = async (query: string) => {
      const r = await fetch(`${api.base}/game/v1/rooms?language=en&${query}`, { headers: basic(viewer) });
      return ((await r.json()) as any[]).map((x) => `${x.world}/${x.zoneId.name}`);
    };
    const fill = async (world: string, n: number) => { for (let i = 0; i < n; i++) await joinRoom(api, await player(api), world); };

    await fill("Iceberg", 3);
    const next = await rooms("rooms=Town&limit=1");
    check(next.join() === "Alpine/Town", `with Iceberg's Town full, the retry gets Alpine (${next})`);
    check(await outcome(await joinRoom(api, await player(api), next[0]!.split("/")[0])) === "200", "a join to the world it returned succeeds");
    check((await rooms("worlds=Glacier&rooms=Town")).join() === "Glacier/Town", "an explicit world filter still returns a world with space");
    check((await rooms("rooms=Beach&limit=1")).join() === "Iceberg/Beach", "other rooms are unaffected by Town being full");

    await fill("Alpine", 2); await fill("Blizzard", 3); await fill("Glacier", 3); await fill("Summit", 3);
    const none = await rooms("rooms=Town&limit=1");
    check(none.length === 0, `with Town full in every world the list is empty (${none})`);
    check((await rooms("worlds=Glacier&rooms=Town")).length === 0, "a full world in the filter is left out");
  } finally {
    logs.push(api.logs());
    await api.stop();
  }
}

// ---- Squatting and oversized room lists (security review fixes) ----
{
  const api = await startWebApi({ env: { ROOM_CAP: "3", ALLOW_SWID_AUTH: "1" } });
  try {
    // A player is in one room at a time: joining another room drops their
    // unconfirmed joins elsewhere, so accounts that join every room and never
    // connect can't hold a place in each of them.
    const squatters = [await player(api), await player(api), await player(api)];
    for (const q of squatters) await joinRoom(api, q, "Iceberg");
    const late = await player(api);
    check(await outcome(await joinRoom(api, late, "Iceberg")) === "full", "three unconfirmed joins fill Iceberg/Town");
    for (const q of squatters) await joinRoom(api, q, "Alpine");
    check(await outcome(await joinRoom(api, late, "Iceberg")) === "200", "joining another room frees a player's unconfirmed place");
    const pending = sql(api, "SELECT COUNT(*) n FROM player_sessions WHERE swid = ? AND confirmed = 0 AND created_at > datetime('now', '-60 seconds')", squatters[0])[0].n;
    check(pending === 1, `only a player's latest unconfirmed join counts (${pending})`);

    // An earlier join's signed token can still be used to connect. When it is,
    // the game server confirms that join and it counts again, so a superseded
    // join can't put a player in a room the cap doesn't see.
    const hopper = await player(api);
    const firstJoin = await (await joinRoom(api, hopper, "Summit", "Beach")).text();
    const firstSession = Number(firstJoin.match(/"sessionId"\s*:\s*(\d+)/)![1]);
    await joinRoom(api, hopper, "Glacier", "Beach");
    await joinRoom(api, await player(api), "Summit", "Beach");
    await joinRoom(api, await player(api), "Summit", "Beach");
    const started = await (await fetch(`${api.base}/api/internal/session-started`, {
      method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ sessionId: firstSession }),
    })).json() as any;
    check(started.known === true, "connecting with a superseded join's token finds its session");
    check(await outcome(await joinRoom(api, await player(api), "Summit", "Beach")) === "full", "and that player counts against the room again");

    // A confirmed join is a live connection: it stays until that connection closes.
    const live = await player(api);
    await joinRoom(api, live, "Blizzard");
    sql(api, "UPDATE player_sessions SET confirmed = 1 WHERE swid = ?", live);
    await joinRoom(api, live, "Glacier");
    const blizzard = sql(api, "SELECT COUNT(*) n FROM player_sessions WHERE swid = ? AND world = 'Blizzard'", live)[0].n;
    check(blizzard === 1, "a confirmed session is not dropped by a new join");

    // The worlds/rooms filters are client text: repeats collapse and the
    // lists are capped, so one request can't ask for millions of rooms.
    const viewer = await player(api);
    const t0 = performance.now();
    // 1,500 repeats keeps the URL under the 16 KB header limit (past it the
    // server answers 431 before the route runs).
    const r = await fetch(`${api.base}/game/v1/rooms?language=en&worlds=${"Summit,".repeat(1500)}Summit&rooms=Diving,Diving,Diving`, { headers: basic(viewer) });
    const list = (await r.json()) as any[];
    check(list.length === 1 && list[0].world === "Summit", `repeated filters give one result (${list.length})`);
    const manyRooms = Array.from({ length: 300 }, (_, i) => `Room${i}`).join(",");
    const capped = (await (await fetch(`${api.base}/game/v1/rooms?language=en&worlds=Summit&rooms=${manyRooms}`, { headers: basic(viewer) })).json()) as any[];
    check(capped.length <= 50, `the rooms filter is capped (${capped.length} results for 300 names)`);
    check(performance.now() - t0 < 2000, `oversized filters answer quickly (${(performance.now() - t0).toFixed(0)} ms)`);
  } finally {
    logs.push(api.logs());
    await api.stop();
  }
}

finish(logs.join("\n"));
