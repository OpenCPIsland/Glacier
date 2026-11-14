import type { Session } from "./session.ts";
import type { OutgoingPacket } from "./sfs-wire.ts";

// Every connected player, keyed by user id. Used for room broadcasts and for
// pushes from the WebAPI (notify-listener.ts).
export interface RegisteredSession {
  session: Session;
  peer: string;
  send: (packet: OutgoingPacket) => void;
  /** Closes the connection. */
  close: () => void;
}

const byUserId = new Map<number, RegisteredSession>();
// Room broadcasts look players up by room on every packet, so they're also
// indexed by the room recorded at register (the login sets roomName before
// registering and nothing changes it afterwards; unregister uses the
// recorded name even if it did).
const byRoom = new Map<string, Set<RegisteredSession>>();
const roomOfUser = new Map<number, string>();

function removeFromRoom(userId: number): void {
  const room = roomOfUser.get(userId);
  const entry = byUserId.get(userId);
  if (room === undefined) return;
  roomOfUser.delete(userId);
  const set = byRoom.get(room);
  if (!set || !entry) return;
  set.delete(entry);
  if (set.size === 0) byRoom.delete(room);
}

export function register(entry: RegisteredSession): void {
  removeFromRoom(entry.session.userId);
  byUserId.set(entry.session.userId, entry);
  const room = entry.session.roomName;
  roomOfUser.set(entry.session.userId, room);
  let set = byRoom.get(room);
  if (!set) byRoom.set(room, (set = new Set()));
  set.add(entry);
}

/** Whether this session is still connected and registered (not closed while a request was in flight). */
export function isRegistered(session: Session): boolean {
  return byUserId.get(session.userId)?.session === session;
}

export function unregister(session: Session): void {
  removeFromRoom(session.userId);
  byUserId.delete(session.userId);
}

// Everyone connected, in any room.
export function getAll(): RegisteredSession[] {
  return [...byUserId.values()];
}

// Everyone in a room, in registration order - the basis for all room broadcasts.
export function getByRoom(roomName: string): RegisteredSession[] {
  const set = byRoom.get(roomName);
  return set ? [...set] : [];
}

/** How many players are in a room (the login's room-cap ceiling reads this). */
export function roomOccupancy(roomName: string): number {
  return byRoom.get(roomName)?.size ?? 0;
}

/** Rooms with at least one player in the index (for tests). */
export function indexedRoomCount(): number {
  return byRoom.size;
}

// Everyone in a room except one user (usually the sender).
export function getByRoomExcluding(roomName: string, excludeUserId: number): RegisteredSession[] {
  return getByRoom(roomName).filter((entry) => entry.session.userId !== excludeUserId);
}

// Lookups for targeted pushes, where only a web API username or SWID is
// known. Matches the verified account, not the login's unsigned "un".
export function getByUsername(userName: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.accountName === userName);
}

// For staff commands: an exact account-name match, else the one connected
// account whose name matches ignoring case (none when that is ambiguous).
export function getByAccountName(name: string): RegisteredSession | undefined {
  const all = [...byUserId.values()].filter((entry) => entry.session.accountName);
  const exact = all.find((entry) => entry.session.accountName === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const loose = all.filter((entry) => entry.session.accountName!.toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

export function getBySwid(swid: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.swid === swid);
}
