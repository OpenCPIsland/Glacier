// The shared live poller behind Home's SSE: one poll for all viewers, only
// while someone watches, signed as a real staff member, never to staff who
// lost the right to see players.
import { makeChecker } from "../../tools/lib/harness.ts";
import { sleep } from "../../tools/lib/staff-client.ts";
import { makeLive } from "../src/live.ts";
import type { StaffRow } from "../src/store.ts";
import type { Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const staffRow = (email: string, role: StaffRow["role"] = "moderator"): StaffRow =>
  ({ email, role, extras: [], linkedSwid: null, disabled: false, addedBy: "x", addedAt: 0, updatedAt: 0, isConfigOwner: false });
const rows = new Map<string, StaffRow>();
const store = { getStaff: (e: string) => rows.get(e) ?? null } as any;
const actorOf = (s: StaffRow): Actor => ({ email: s.email, role: s.role, extras: s.extras });

const calls: { who: string; side: string; path: string; action: string }[] = [];
let gameDown = false;
const EVIL = "<b>x</b>‮evil";
const fake = {
  async callWebApi(actor: Actor, action: string, _m: string, path: string) {
    calls.push({ who: actor.email, side: "web", path, action });
    return { ok: true as const, status: 200, json: { openReports: 3, activeMutes: 2, activeBans: 1 } };
  },
  async callGameServer(actor: Actor, action: string, _m: string, path: string) {
    calls.push({ who: actor.email, side: "game", path, action });
    if (gameDown) return { ok: false as const, unreachable: true as const, detail: "down" };
    return { ok: true as const, status: 200, json: { players: [
      { swid: "{a}", accountName: "A", role: "player", world: "Iceberg", room: EVIL },
      { swid: "{b}", accountName: "B", role: "player", world: "Iceberg", room: EVIL },
      { swid: "{c}", accountName: "C", role: "player", world: "Iceberg", room: "Town" },
      { swid: "{d}", accountName: "D", role: "player", world: "Other", room: "Dock" },
    ] } };
  },
};

async function take(stream: ReadableStream, n: number): Promise<any[]> {
  const reader = stream.getReader(); const out: any[] = []; let buf = "";
  const end = Date.now() + 5000;
  while (out.length < n && Date.now() < end) {
    const r = await Promise.race([reader.read(), sleep(end - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    buf += new TextDecoder().decode(r.value);
    let i; while ((i = buf.indexOf("\n\n")) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); if (c.startsWith("data: ")) out.push({ raw: c.slice(6), ev: JSON.parse(c.slice(6)) }); }
  }
  reader.releaseLock();
  return out;
}

const live = makeLive(fake as any, store, { intervalMs: 150 });
const ann = staffRow("ann@x.com"); const bob = staffRow("bob@x.com"); rows.set(ann.email, ann); rows.set(bob.email, bob);

await sleep(400);
check(calls.length === 0, "no viewers → no polling");

const s1 = live.subscribe(ann, actorOf(ann));
const [first] = await take(s1, 1);
check(first?.ev.online === 4 && first.ev.openReports === 3 && first.ev.activeMutes === 2 && first.ev.activeBans === 1, `event carries the counts (${first?.raw})`);
check(first?.ev.webapi === "up" && first.ev.game === "up", "both up");
const iceberg = first?.ev.worlds.find((w: any) => w.world === "Iceberg");
check(iceberg?.total === 3 && iceberg.rooms.find((r: any) => r.room === EVIL)?.count === 2 && iceberg.rooms.find((r: any) => r.room === "Town")?.count === 1, "worlds group players into rooms with counts");
check(first?.raw.startsWith("{") && !first.raw.includes("\n"), "the event is one line of JSON; hostile room names are data, not markup");
check(calls.every((c) => c.who === "ann@x.com") && calls.some((c) => c.path === "/online" && c.action === "players.view") && calls.some((c) => c.path === "/stats"), "polled /online and /stats, signed as the viewer");

const s2 = live.subscribe(bob, actorOf(bob));
const [late] = await take(s2, 1);
check(late?.ev.online === 4, "a viewer joining mid-way gets the latest event at once");
calls.length = 0;
await sleep(700);
const onlineCalls = calls.filter((c) => c.path === "/online");
check(onlineCalls.length >= 2 && onlineCalls.length <= 6, `two viewers share one poll (${onlineCalls.length} /online calls in 0.7 s)`);
check(calls.every((c) => c.who === "ann@x.com"), "polls are signed by the longest-connected viewer");

gameDown = true;
const [down] = (await take(live.subscribe(ann, actorOf(ann)), 3)).slice(-1);
check(down?.ev.game === "down" && down.ev.webapi === "up" && down.ev.online === null && down.ev.worlds.length === 0, `game down → game: down, online null, no worlds (${down?.raw})`);
gameDown = false;

// A viewer whose staff row is disabled or lost players.view gets cut off.
rows.set(bob.email, { ...bob, disabled: true });
const r2 = s2.getReader();
let closed = false;
const endAt = Date.now() + 3000;
while (Date.now() < endAt) { const r = await Promise.race([r2.read(), sleep(500).then(() => "t" as const)]); if (r !== "t" && (r as any).done) { closed = true; break; } }
check(closed, "a disabled staff member's stream is closed");

rows.set(ann.email, { ...ann, extras: [], role: "moderator", disabled: true });
await sleep(600);
calls.length = 0;
await sleep(600);
check(calls.length === 0, "polling stops when nobody watching is allowed to");

finish();
process.exit(0);
