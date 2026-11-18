import { getUtfString } from "../wire-helpers.ts";
import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";
import type { Session } from "../session.ts";
import { logSafe } from "../log-safe.ts";
import { zoneOfRoom } from "../scene-switches.ts";
import { fetchRoomCollected } from "../webapi-client.ts";

// Answer task.p with reward.room carrying EVERYTHING collected in the room
// (saved ones, read once per visit, + this session's); the client posts it
// to /reward/v1/room, which saves it. The web API still decides what pays.
interface RoomCollected { room: string; collected: Promise<Record<string, number>> }
const bySession = new WeakMap<Session, RoomCollected>();

export async function handlePickup(innerParams: SFSObjectData, ctx: HandlerContext): Promise<void> {
  const id = getUtfString(innerParams, "id");
  const room = zoneOfRoom(ctx.session.roomName);
  if (!id || id.length > 512 || !room) return;
  await ctx.session.identityReady;
  let state = bySession.get(ctx.session);
  if (state?.room !== room) {
    const acct = ctx.session.accountName;
    state = { room, collected: (acct ? fetchRoomCollected(acct, room) : Promise.resolve(null)).then((c) => ({ ...(c ?? {}) })) };
    bySession.set(ctx.session, state);
  }
  const collected = await state.collected;
  collected[id] = Date.now();
  if (bySession.get(ctx.session) !== state) return;
  const reward = { goodUntil: 0, signature: "", swid: "", data: { room, collected } };
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "reward.room")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("reward", JSON.stringify(reward)))));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - task.p pickup in ${logSafe(room)} (id=${logSafe(id)}) -> reward.room`);
}
