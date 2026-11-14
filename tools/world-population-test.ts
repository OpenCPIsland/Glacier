// The client's "servers" are worlds. New joins land in the first world the
// web API lists (Iceberg), any world name can be joined and is its own set of
// rooms, and populations count the players in each world, not the room total.
// World, language and room names that could break the signed room name
// ("world:language:room:instance:content") are refused.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
// ROOM_CAP=30 gives the population steps 1/5/10/20/30 these checks were
// written against (the bars scale with the cap; see room-cap-test.ts).
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", ROOM_CAP: "30" } });
const BASE = api.base;
const headers = (swid: string) => ({ Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json" });
const get = async (swid: string, path: string) => (await fetch(`${BASE}${path}`, { headers: headers(swid) })).json() as Promise<any>;
const join = (swid: string, world: string, room: string, language = "en") =>
  fetch(`${BASE}/game/v1/worlds/${encodeURIComponent(world)}/language/${encodeURIComponent(language)}/rooms/${encodeURIComponent(room)}/players`, { method: "POST", headers: headers(swid), body: "{}" });
const worldPop = async (viewer: string, room: string) =>
  Object.fromEntries(((await get(viewer, `/game/v1/world/roomPopulation/${room}?language=en`)).worldRoomPopulations as any[]).map((w) => [w.worldName, w.populationScaled]));
const roomPop = async (viewer: string, world: string, room: string) =>
  ((await get(viewer, `/game/v1/roomPopulation/${encodeURIComponent(world)}?language=en`)).roomPopulations as any[]).find((p) => p.identifier.zoneId.name === room)?.populationScaled;

try {
  const P = Array.from({ length: 8 }, (_, i) => `{AAAA0000-0000-0000-0000-00000000000${i}}`);
  for (let i = 0; i < P.length; i++) await createPlayer(BASE, api.dbPath, P[i]!, `World${i}`);
  const viewer = P[7]!;

  // ---- where new joins land ----
  const list = await get(viewer, "/game/v1/rooms?language=en&rooms=Town&limit=1");
  check(list.length === 1 && list[0].world === "Iceberg", `a join without a world lands in Iceberg (${list[0]?.world})`);
  const all = await get(viewer, "/game/v1/rooms?language=en&rooms=Town");
  check(JSON.stringify(all.map((r: any) => r.world)) === '["Iceberg","Alpine","Blizzard","Glacier","Summit"]', "the world list keeps the other known worlds");
  const filtered = await get(viewer, "/game/v1/rooms?language=en&rooms=Town&worlds=Iceberg,a:b,x;y,Alpine");
  check(JSON.stringify(filtered.map((r: any) => r.world)) === '["Iceberg","Alpine"]', "a world filter drops names with : or ;");

  // ---- joins in different worlds ----
  const db0 = new Database(api.dbPath); db0.run("DELETE FROM player_sessions"); db0.close();
  check((await join(P[0]!, "Iceberg", "Beach")).status === 200, "join Beach in Iceberg");
  check((await join(P[1]!, "Blizzard", "Beach")).status === 200, "join Beach in Blizzard");
  check((await join(P[2]!, "Cod", "Beach")).status === 200, "join Beach in Cod (a world outside the known five)");
  check((await join(P[3]!, "Glacière", "Beach")).status === 200, "a world name with an accent is fine");
  check((await join(P[4]!, "Cream Soda", "Town")).status === 200, "a world name with a space is fine");

  // ---- per-world populations ----
  const wp = await worldPop(viewer, "Beach");
  check(wp.Iceberg === 1 && wp.Blizzard === 1 && wp.Alpine === 0 && wp.Glacier === 0 && wp.Summit === 0, `Beach per world: ${JSON.stringify(wp)}`);
  check(wp.Cod === 1 && wp["Glacière"] === 1, "worlds outside the known five with players are listed with their own count");
  check(wp["Cream Soda"] === undefined, "a world with nobody in this room is not listed");
  check(await roomPop(viewer, "Iceberg", "Beach") === 1 && await roomPop(viewer, "Blizzard", "Beach") === 1 && await roomPop(viewer, "Alpine", "Beach") === 0, "roomPopulation counts the asked world only");
  const reported = ((await get(viewer, "/game/v1/roomPopulation/Iceberg?language=en")).roomPopulations as any[]).map((p) => p.identifier.zoneId.name);
  check(["Town", "Boardwalk", "Beach", "MtBlizzard", "Diving", "DotsShop"].every((z) => reported.includes(z)) && !reported.includes("Reef"), `populations cover the client's real zones (${reported.join(",")})`);
  check(await roomPop(viewer, "Iceberg", "Town") === 0 && await roomPop(viewer, "Cream Soda", "Town") === 1, "and only the asked room");

  // Five more in Iceberg's Beach: that world's scale rises, the others' don't.
  for (const swid of [P[5]!, P[6]!]) await join(swid, "Iceberg", "Beach");
  const db1 = new Database(api.dbPath);
  for (let i = 0; i < 3; i++) db1.run("INSERT INTO player_sessions (session_id, swid, username, room_name, world, instance_id, client_version, last_activity, created_at, confirmed) SELECT ?, swid, username, 'Beach', 'Iceberg', '', client_version, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1 FROM player_sessions WHERE swid = ? LIMIT 1", [900000 + i, P[0]]);
  db1.close();
  check((await worldPop(viewer, "Beach")).Iceberg === 2 && (await worldPop(viewer, "Beach")).Blizzard === 1, "5 players in Iceberg's Beach is scale 2 there and still 1 in Blizzard");

  // Sessions stored before worlds were recorded count as Alpine.
  const db2 = new Database(api.dbPath);
  db2.run("UPDATE player_sessions SET world = NULL WHERE world = 'Blizzard'");
  db2.close();
  const legacy = await worldPop(viewer, "Beach");
  check(legacy.Alpine === 1 && legacy.Blizzard === 0, `a session without a world counts in Alpine (${JSON.stringify(legacy)})`);

  // ---- names that would break the signed room name ----
  for (const [world, language, room, why] of [
    ["a:b", "en", "Town", "world with :"], ["x;y", "en", "Town", "world with ;"], ["Iceberg", "en:1", "Town", "language with :"],
    ["Iceberg", "en", "Town:", "room with :"], ["Iceberg", "en", "Beach;evil", "room with ;"], ["A".repeat(41), "en", "Town", "overlong world"],
    ["Iceberg", "en", "Tow\u0001n", "control character"],
    ["{AAAAAAAA-1111-2222-3333-444444444444}", "en", "Town", "world that looks like a swid"],
    ["Iceberg", "{AAAAAAAA-1111-2222-3333-444444444444}", "Town", "language that looks like a swid"],
    ["Iceberg", "en", "{AAAAAAAA-1111-2222-3333-444444444444}", "room that looks like a swid"],
    ["Igloo", "en", "Town", "the igloo world"], ["igloo", "en", "Town", "the igloo world in lower case"],
    [" Iceberg", "en", "Town", "world starting with a space"], ["Ice<b>berg", "en", "Town", "world with markup"],
    ["Iceberg", "en", "Town Square", "room with a space"], ["Iceberg", "english-language-too-long", "Town", "overlong language"],
  ] as const) {
    const r = await join(P[0]!, world, room, language);
    check(r.status === 400, `${why} -> ${r.status}`);
  }
  check((await join(P[0]!, "Ice Age", "Town", "en_US")).status === 200 && (await join(P[0]!, "Patinoire", "Boardwalk", "fr")).status === 200, "ordinary world names and languages (en_US, fr) are fine");
  const igl = await fetch(`${BASE}/game/v1/igloos/language/${encodeURIComponent("{AAAAAAAA-1111-2222-3333-444444444444}")}/players`, { method: "POST", headers: headers(P[0]!), body: JSON.stringify({ name: "DefaultIgloo", instanceId: P[0] }) });
  check(igl.status === 400, `the igloo route refuses a language that looks like a swid -> ${igl.status}`);
} finally {
  api.stop();
}
finish(api.logs());
