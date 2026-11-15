import { getUtfString } from "../wire-helpers.ts";
import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";
import { logSafe } from "../log-safe.ts";

function getBaseRoomName(roomName: string): string {
  const parts = roomName.split("::")[0].split(":");
  return parts.length >= 3 && parts[2] ? parts[2] : parts[0];
}

export function handlePickup(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const id = getUtfString(innerParams, "id");
  if (id === undefined) return;

  // add `earnedRewards: Map<string, number>` to your session type
  const session = ctx.session;
    session.earnedRewards ??= new Map<string, number>();
  session.earnedRewards.set(id, Date.now());

const collected = Object.fromEntries(session.earnedRewards);
const room = getBaseRoomName(session.roomName);

const signed = {
  goodUntil: Date.now() + 3600000,
  swid: session.swid ?? "",
  data: { room: getBaseRoomName(session.roomName), collected: Object.fromEntries(session.earnedRewards) },
  signature: "server_signature",
};

  const packet = encodePacket(
    1, 13,
    new SFSObjectWriter()
      .putUtfString("c", "reward.room")
      .putInt("r", 1)
      .putSFSObject("p", new SFSObjectWriter().putUtfString("reward", JSON.stringify(signed))),
  );
console.log("[reward.room out]", JSON.stringify(signed));
  ctx.send(packet);
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - task.p pickup id=${logSafe(id)} -> reward.room`);
}