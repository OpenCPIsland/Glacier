import { getUtfString } from "../wire-helpers.ts";
import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";
import type { Session } from "../session.ts";
import { logSafe } from "../log-safe.ts";
import { zoneOfRoom } from "../scene-switches.ts";
import { fetchRoomCollected } from "../webapi-client.ts";

// "task.p" - sent when a collectible (shell, gem...) is picked up. `id` =
// item path, `t` = collectible type, `p` = position (Vec3). The answer is
// "reward.room" with a SignedResponse<InRoomRewards> {room: zone name,
// collected: {path: time}}; the client posts that to the web API's
// /reward/v1/room, which saves the currency. Without it nothing is saved.
//
// The client REPLACES its set of collected items with each reward.room, so
// the answer carries everything collected in the room: what the web API has
// saved (read once per room visit) plus this session's pickups there.
// Otherwise earlier items reappear and their re-pickup is refused. The web
// API decides what pays (paths in its pickupables data, respawn times on
// its own clock), so this only relays what was picked up.
const MAX_ID_LENGTH = 512;

interface RoomCollected { room: string; collected: Promise<Record<string, number>> }
const collectedBySession = new WeakMap<Session, RoomCollected>();

function roomCollected(session: Session, room: string): RoomCollected {
  let state = collectedBySession.get(session);
  if (state?.room !== room) {
    const account = session.accountName;
    state = { room, collected: (account ? fetchRoomCollected(account, room) : Promise.resolve(null)).then((c) => ({ ...(c ?? {}) })) };
    collectedBySession.set(session, state);
  }
  return state;
}

export async function handlePickup(innerParams: SFSObjectData, ctx: HandlerContext): Promise<void> {
  const id = getUtfString(innerParams, "id");
  const collectibleType = getUtfString(innerParams, "t");
  const room = zoneOfRoom(ctx.session.roomName);
  if (!id || id.length > MAX_ID_LENGTH || !room) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - task.p pickup ignored (id=${logSafe((id ?? "?").slice(0, 80))}, room=${logSafe(room || "?")})`);
    return;
  }
  await ctx.session.identityReady;
  const state = roomCollected(ctx.session, room);
  const collected = await state.collected;
  collected[id] = Date.now();
  if (collectedBySession.get(ctx.session) !== state) return; // left the room meanwhile
  const reward = { goodUntil: 0, signature: "", swid: "", data: { room, collected } };
  const params = new SFSObjectWriter()
    .putUtfString("c", "reward.room")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("reward", JSON.stringify(reward)));
  ctx.send(encodePacket(1, 13, params));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - task.p pickup in ${logSafe(room)} (id=${logSafe(id)}, type=${logSafe(collectibleType ?? "?")}) -> reward.room (${Object.keys(collected).length} collected)`);
}