// The most players one room (or igloo) takes. A crowded room costs the game
// server per move sent to everyone else in it, so past a few hundred players
// joins stall; ROOM_CAP keeps every room well below that. The game server
// reads the same variable for its backstop ceiling.

const DEFAULT_ROOM_CAP = 100;

/** ROOM_CAP from the environment, read at call time; anything but a positive integer means 100. */
export function roomCap(): number {
    const raw = process.env.ROOM_CAP;
    const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_ROOM_CAP;
}

// Rooms the game server refused a login into (its ROOM_CAP + headroom
// ceiling). Its count is the real one; the web API's can be lower (a session
// it lost track of), and then the client's world-less room-full retry would
// be sent straight back into the room it was just refused from, forever. So a
// refused room counts as full here for a minute.
export const ROOM_FULL_MARK_MS = 60_000;
const markedFull = new Map<string, number>(); // room key -> until (ms)
const markKey = (world: string, room: string, instanceId: string, clientVersion: string) =>
    [world, room, instanceId, clientVersion].join("\n");

export function markRoomFull(world: string, room: string, instanceId: string, clientVersion: string, now = Date.now()): void {
    for (const [k, until] of markedFull) if (until <= now) markedFull.delete(k);
    markedFull.set(markKey(world, room, instanceId, clientVersion), now + ROOM_FULL_MARK_MS);
}

export function isMarkedFull(world: string, room: string, instanceId: string, clientVersion: string, now = Date.now()): boolean {
    const until = markedFull.get(markKey(world, room, instanceId, clientVersion));
    return until !== undefined && until > now;
}

/**
 * The parts of a signed room name, "world:language:room:instance:content",
 * where content starts with the client version ("1.13.0;live;…"). Null if it
 * isn't one.
 */
export function parseRoomName(name: unknown): { world: string; room: string; instanceId: string; clientVersion: string } | null {
    if (typeof name !== "string" || name.length > 300) return null;
    const parts = name.split(":");
    if (parts.length !== 5) return null;
    const [world, , room, instanceId, content] = parts as [string, string, string, string, string];
    const clientVersion = content.split(";")[0] ?? "";
    if (!world || !room || !clientVersion) return null;
    return { world, room, instanceId, clientVersion };
}

/**
 * RoomPopulationScale (0 ZERO to 5 FIVE) for `count` players in a room of
 * `cap`. FIVE means the room is full: the client's server list refuses to
 * switch into a world that shows FIVE, so FIVE must start exactly at the
 * cap, with the lower steps spread under it.
 */
export function populationScaleFor(count: number, cap: number): number {
    if (count >= cap) return 5;
    if (count >= Math.ceil((cap * 2) / 3)) return 4;
    if (count >= Math.ceil(cap / 3)) return 3;
    if (count >= Math.ceil(cap / 6)) return 2;
    if (count >= 1) return 1;
    return 0;
}
