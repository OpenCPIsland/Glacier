// The game server's room ceiling (ROOM_CAP + ROOM_CAP_HEADROOM): a login into
// a room at the ceiling gets SFS join error 20 (the client's ROOM_FULL, which
// makes it retry in another world), is never put in the room, is closed, and
// its web API session ends. The web API runs with a high cap here so its own
// gate lets the joins through and the game server is the one that refuses.
// Wire layout of the error from the client's SFS2X source (archived_sfs2x
// branch): SystemController.FnJoinRoom reads "ec" (short) and "ep" (UTF
// string array); DefaultSFSDataSerializer writes type 16, a short count,
// then each string with a short length.
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";
const createPlayerForJoin = (api: { base: string; dbPath: string }, swid: string) => createPlayer(api.base, api.dbPath, swid, swid.replace(/\W/g, ""));
import { SFSObjectWriter, encodePacket, tryReadHeader, decodeSFSObject, SFSDataType } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();

// ---- the error packet's bytes ----
{
  const room = "Iceberg:en:Town::x";
  const bytes = encodePacket(0, 4, new SFSObjectWriter().putShort("ec", 20).putUtfStringArray("ep", [room])).encode("sfs2x");
  const at = bytes.indexOf(Buffer.from([0x00, 0x02, 0x65, 0x70])); // key "ep" with its 2-byte length
  const after = bytes.subarray(at + 4);
  check(at > 0 && after[0] === 16 && after.readUInt16BE(1) === 1 && after.readUInt16BE(3) === room.length
    && after.toString("utf8", 5, 5 + room.length) === room, "ep is UTF_STRING_ARRAY: type 16, count 1, length-prefixed string");
  const h = tryReadHeader(bytes, "sfs2x")!;
  const p = (decodeSFSObject(bytes.subarray(h.headerLength, h.totalLength), 0, "sfs2x").value.p!.value) as any;
  check(p.ec.type === SFSDataType.SHORT && p.ec.value === 20, "ec decodes as SHORT 20");
  check(JSON.stringify(p.ep.value) === JSON.stringify([room]), `ep decodes as [room] (${JSON.stringify(p.ep.value)})`);
}

// ---- end to end ----
const key = crypto.randomBytes(32).toString("hex");
const api = await startWebApi({ env: { ROOM_CAP: "1000", ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: key } });
const gs = await startGameServer(api, key, { ROOM_CAP: "3", ROOM_CAP_HEADROOM: "0" });
try {
  const clients = [1, 2, 3, 4].map((i) => new GameClient(api, gs.port, `{CEIL-${i}}`, `Ceil${i}`));
  for (const c of clients) { await c.connect(); await sleep(150); }
  const [c1, c2, c3, c4] = clients as [GameClient, GameClient, GameClient, GameClient];
  check([c1, c2, c3].every((c) => c.joinReplies[0] && !c.joinReplies[0].ec), "the first three logins join the room");
  check(c4.joinReplies[0]?.ec?.value === 20, `the 4th login gets join error 20 (${JSON.stringify(c4.joinReplies[0]?.ec)})`);
  const roomName = (c1.joinReplies[0]?.r?.value as any[])?.[1]?.value; // the room array's name
  check(JSON.stringify(c4.joinReplies[0]?.ep?.value) === JSON.stringify([roomName]), `ep carries the room name (${JSON.stringify(c4.joinReplies[0]?.ep?.value)})`);
  const maxUsers = (c1.joinReplies[0]?.r?.value as any[])?.[7]?.value;
  check(maxUsers === 3, `the room advertises maxUsers = ROOM_CAP (${maxUsers})`);

  for (let i = 0; i < 35 && !c4.closed; i++) await sleep(100);
  check(c4.closed, "the refused connection is closed by the server");
  let rows = 1;
  for (let i = 0; i < 35 && rows > 0; i++) {
    const d = new Database(api.dbPath, { readonly: true });
    rows = (d.query("SELECT COUNT(*) n FROM player_sessions WHERE session_id = ?").get(c4.sid) as any).n;
    d.close();
    if (rows > 0) await sleep(100);
  }
  check(rows === 0, "the refused join's web API session ended");

  // Nobody in the room ever saw the refused player. (Review Focus 5)
  check([c1, c2, c3].every((c) => !c.added.some((a) => a.id === c4.myId)), "no occupant was shown the refused avatar");
  check([c1, c2, c3].every((c) => !c.removed.includes(c4.myId)), "no occupant got a user-left for it");

  // The refusal is reported to the web API, which then treats the room as
  // full, so the client's world-less retry can't be sent back into it (the
  // web API's own count here is far below its cap of 1000).
  const asViewer = { Authorization: "Basic " + btoa("{CEIL-1}:x"), "Content-Type": "application/json" };
  let listed: any[] = [{}];
  for (let i = 0; i < 30 && listed.length > 0; i++) {
    listed = (await (await fetch(`${api.base}/game/v1/rooms?language=en&worlds=Alpine&rooms=Town`, { headers: asViewer })).json()) as any[];
    if (listed.length > 0) await sleep(100);
  }
  check(listed.length === 0, "after a ceiling refusal the room-full retry no longer gets that room");
  await createPlayerForJoin(api, "{CEIL-6}");
  const sixth = await fetch(`${api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, {
    method: "POST", headers: { Authorization: "Basic " + btoa("{CEIL-6}:x"), "Content-Type": "application/json" }, body: "{}",
  });
  check(sixth.status === 409, `and a new join to it is refused by the web API too (${sixth.status})`);
  const beach = (await (await fetch(`${api.base}/game/v1/rooms?language=en&worlds=Alpine&rooms=Beach`, { headers: asViewer })).json()) as any[];
  check(beach.length === 1, "other rooms in that world are unaffected");
  const noSecret = await fetch(`${api.base}/api/internal/room-full`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: "Alpine:en:Beach::1.13.0;live;x;NONE" }),
  });
  check(noSecret.status === 403, `room-full needs the internal secret (${noSecret.status})`);

  const c5 = new GameClient(api, gs.port, "{CEIL-5}", "Ceil5", "Beach");
  await c5.connect();
  check(c5.joinReplies[0] !== undefined && !c5.joinReplies[0].ec, "another room still takes logins (the ceiling is per room)");
} finally {
  gs.stop();
  await api.stop();
}
finish(gs.logs());
