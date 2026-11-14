// One shared poller behind Home's live view. It runs only while someone is
// watching, makes one /online + /stats poll per tick however many people
// watch, signs the calls as the longest-connected viewer (so the listener
// logs name a real staff member), and re-checks every viewer each tick: a
// staff member who was disabled or lost players.view is cut off.
import { can } from "../shared/permissions.ts";
import type { Actor } from "../shared/signing.ts";
import type { Clients } from "./clients.ts";
import type { Store, StaffRow } from "./store.ts";
import { setOpenReports } from "./pages/layout.ts";

export interface LiveEvent {
  online: number | null;
  openReports: number | null;
  activeMutes: number | null;
  activeBans: number | null;
  worlds: { world: string; total: number; rooms: { room: string; count: number }[] }[];
  webapi: "up" | "down";
  game: "up" | "down";
}

interface Viewer { staff: StaffRow; actor: Actor; since: number; ctl: ReadableStreamDefaultController<Uint8Array>; }

const MAX_VIEW_MS = 10 * 60_000; // the browser reconnects, which re-checks Access and the staff list

export function makeLive(clients: Clients, store: Store, opts: { intervalMs?: number; maxViewMs?: number } = {}) {
  const interval = opts.intervalMs ?? 5000;
  const maxView = opts.maxViewMs ?? MAX_VIEW_MS;
  const enc = new TextEncoder();
  const viewers = new Set<Viewer>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let latest: LiveEvent | null = null;

  const send = (v: Viewer, ev: LiveEvent) => {
    try { v.ctl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { drop(v); }
  };
  const drop = (v: Viewer) => {
    viewers.delete(v);
    try { v.ctl.close(); } catch { /* already closed */ }
    if (viewers.size === 0) { clearTimeout(timer); timer = undefined; latest = null; }
  };

  function group(players: any[]): LiveEvent["worlds"] {
    const worlds = new Map<string, Map<string, number>>();
    for (const p of players) {
      const w = typeof p?.world === "string" && p.world ? p.world : "?";
      const r = typeof p?.room === "string" && p.room ? p.room : "?";
      const rooms = worlds.get(w) ?? new Map<string, number>();
      rooms.set(r, (rooms.get(r) ?? 0) + 1);
      worlds.set(w, rooms);
    }
    return [...worlds].map(([world, rooms]) => ({
      world,
      total: [...rooms.values()].reduce((a, b) => a + b, 0),
      rooms: [...rooms].map(([room, count]) => ({ room, count })).sort((a, b) => b.count - a.count),
    })).sort((a, b) => b.total - a.total);
  }

  async function tick() {
    timer = undefined;
    if (polling) return;
    polling = true;
    try {
      // Re-check everyone first; whoever can't watch any more is closed.
      const now = Date.now();
      for (const v of [...viewers]) {
        const s = store.getStaff(v.staff.email);
        if (!s || s.disabled || !can(s.role, s.extras, "players.view") || now - v.since > maxView) { drop(v); continue; }
        v.staff = s; v.actor = { email: s.email, role: s.role, extras: s.extras };
      }
      if (viewers.size === 0) return;
      const lead = [...viewers].sort((a, b) => a.since - b.since)[0]!;
      const [online, stats] = await Promise.all([
        clients.callGameServer(lead.actor, "players.view", "GET", "/online"),
        clients.callWebApi(lead.actor, "dashboard.view", "GET", "/stats"),
      ]);
      const gameUp = online.ok && online.status === 200 && Array.isArray(online.json?.players);
      const webUp = stats.ok && stats.status === 200;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const players: any[] = gameUp ? (online as any).json.players : [];
      const ev: LiveEvent = {
        online: gameUp ? players.length : null,
        openReports: webUp ? num((stats as any).json?.openReports) : null,
        activeMutes: webUp ? num((stats as any).json?.activeMutes) : null,
        activeBans: webUp ? num((stats as any).json?.activeBans) : null,
        worlds: gameUp ? group(players) : [],
        webapi: webUp ? "up" : "down",
        game: gameUp ? "up" : "down",
      };
      latest = ev;
      if (ev.openReports !== null) setOpenReports(ev.openReports);
      for (const v of [...viewers]) send(v, ev);
    } finally {
      polling = false;
      if (viewers.size > 0 && !timer) timer = setTimeout(tick, interval);
    }
  }

  return {
    subscribe(staff: StaffRow, actor: Actor, signal?: AbortSignal): ReadableStream<Uint8Array> {
      let me: Viewer | undefined;
      return new ReadableStream<Uint8Array>({
        start(ctl) {
          me = { staff, actor, since: Date.now(), ctl };
          viewers.add(me);
          signal?.addEventListener("abort", () => me && drop(me));
          if (latest) send(me, latest);
          if (!timer && !polling) timer = setTimeout(tick, 0);
        },
        cancel() { if (me) drop(me); },
      });
    },
  };
}
