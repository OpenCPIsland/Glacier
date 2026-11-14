// The game server's per-room session index (session-registry.ts), in-process:
// room lookups return the room's players in registration order, occupancy
// counts them, the room recorded at register is the one unregister removes
// from, and emptied rooms leave nothing behind.
import { makeChecker } from "./lib/harness.ts";
import {
  register, unregister, getByRoom, getByRoomExcluding, roomOccupancy, indexedRoomCount,
} from "../smartfox-server/src/session-registry.ts";

const { check, finish } = makeChecker();
const sessions = new Map<number, any>();
function e(userId: number, roomName: string) {
  const session = { userId, roomName } as any;
  sessions.set(userId, session);
  return { session, peer: "x", send() {}, close() {} };
}
const ids = (list: { session: { userId: number } }[]) => list.map((x) => x.session.userId).join();

const before = indexedRoomCount();
register(e(1, "A")); register(e(2, "A")); register(e(3, "B"));
check(ids(getByRoom("A")) === "1,2", `room A in registration order (${ids(getByRoom("A"))})`);
check(roomOccupancy("A") === 2 && roomOccupancy("B") === 1 && roomOccupancy("C") === 0, "occupancy per room");
check(ids(getByRoomExcluding("A", 1)) === "2", "excluding the sender");
unregister(sessions.get(3));
check(roomOccupancy("B") === 0 && getByRoom("B").length === 0, "last one out empties the room");
const s2 = sessions.get(2);
s2.roomName = "Z"; // changed after register
unregister(s2);
check(roomOccupancy("A") === 1 && roomOccupancy("Z") === 0, "unregister uses the room recorded at register");
unregister(sessions.get(1));
check(indexedRoomCount() === before, `no rooms left in the index (${indexedRoomCount()})`);

for (let i = 0; i < 1000; i++) register(e(10_000 + i, `room-${i}`));
check(indexedRoomCount() === before + 1000, "1,000 rooms indexed");
for (let i = 0; i < 1000; i++) unregister(sessions.get(10_000 + i));
check(indexedRoomCount() === before, `the index is empty again after 1,000 joins and leaves (${indexedRoomCount()})`);

finish();
