// Puts a staff member's panel role onto their linked game account: the web
// API sets players.role together with its lock, then the game server
// updates any live session. Each sync is one audit row recording the steps
// that completed and the one that failed.
import { IN_GAME_ROLE } from "../shared/permissions.ts";
import type { Actor } from "../shared/signing.ts";
import type { Clients } from "./clients.ts";
import { appendAudit } from "./audit.ts";
import type { Store, StaffRow } from "./store.ts";

export type GameRole = "player" | "moderator" | "admin";

export type Resolved =
  | { ok: true; swid: string; username: string; role: string; configAdmin: boolean }
  | { ok: false; notFound: boolean; detail: string };

export type SyncResult =
  | { ok: true; username: string | null }
  | { ok: false; step: "resolve" | "webapi" | "game" | "old-account"; detail: string; unreachable: boolean };

export const expectedGameRole = (staff: StaffRow): GameRole => (staff.disabled ? "player" : IN_GAME_ROLE[staff.role]);

export function makeRoleSync(clients: Clients, store: Store) {
  async function resolve(actor: Actor, query: string): Promise<Resolved> {
    const r = await clients.callWebApi(actor, "staff.view", "POST", "/player/resolve", { query });
    if (!r.ok) return { ok: false, notFound: false, detail: `web API unreachable: ${r.detail}` };
    if (r.status === 404) return { ok: false, notFound: true, detail: "no such game account" };
    if (r.status !== 200) return { ok: false, notFound: false, detail: `web API answered ${r.status}` };
    return { ok: true, swid: r.json.swid, username: r.json.username, role: r.json.role, configAdmin: !!r.json.configAdmin };
  }

  async function setGameRole(actor: Actor, username: string, role: GameRole): Promise<{ ok: true } | { ok: false; step: "webapi" | "game"; detail: string; unreachable: boolean }> {
    const w = await clients.callWebApi(actor, "role.sync", "POST", "/role", { username, role });
    if (!w.ok) return { ok: false, step: "webapi", detail: `web API unreachable: ${w.detail}`, unreachable: true };
    if (w.status === 409) return { ok: false, step: "webapi", detail: "account is in STAFF_ADMINS (always admin in game); remove it there first", unreachable: false };
    if (w.status !== 200) return { ok: false, step: "webapi", detail: `answered ${w.status}`, unreachable: false };
    const g = await clients.callGameServer(actor, "role.sync", "POST", "/session-role", { username: w.json.username, role });
    if (!g.ok) return { ok: false, step: "game", detail: `game server unreachable (role saved; live session not updated): ${g.detail}`, unreachable: true };
    if (g.status !== 200) return { ok: false, step: "game", detail: `game server answered ${g.status}`, unreachable: false };
    return { ok: true };
  }

  /** Syncs staff's link. previousSwid: the link before this change; that account is set to player and unlocked. */
  async function syncRole(actor: Actor, staff: StaffRow, previousSwid: string | null = null): Promise<SyncResult> {
    const role = expectedGameRole(staff);
    const steps: string[] = [];
    let result: SyncResult = { ok: true, username: null };

    if (staff.linkedSwid) {
      const who = await resolve(actor, staff.linkedSwid);
      if (!who.ok) result = { ok: false, step: "resolve", detail: who.detail, unreachable: !who.notFound };
      else {
        steps.push(`resolved ${who.username}`);
        const set = await setGameRole(actor, who.username, role);
        if (!set.ok) {
          if (set.step === "game") steps.push(`${who.username} → ${role} in the web API`);
          result = set;
        } else {
          steps.push(`${who.username} → ${role}`);
          result = { ok: true, username: who.username };
        }
      }
    }

    if (previousSwid && previousSwid !== staff.linkedSwid) {
      const old = await resolve(actor, previousSwid);
      if (old.ok) {
        const set = await setGameRole(actor, old.username, "player");
        const unlock = await clients.callWebApi(actor, "role.sync", "POST", "/role/unlock", { username: old.username });
        if (set.ok && unlock.ok && unlock.status === 200) steps.push(`old account ${old.username} → player, unlocked`);
        else if (result.ok) result = { ok: false, step: "old-account", detail: `old account ${old.username}: ${!set.ok ? set.detail : "unlock failed"}`, unreachable: !set.ok && set.unreachable };
      } else if (result.ok && !old.notFound) {
        result = { ok: false, step: "old-account", detail: old.detail, unreachable: true };
      }
    }

    appendAudit(store, {
      actor: actor.email, role: actor.role, action: "role.sync", target: staff.email,
      params: { link: staff.linkedSwid, previous: previousSwid, role, steps },
      reason: null,
      result: result.ok ? "ok" : result.unreachable ? "unreachable" : "error",
      detail: result.ok ? null : `${result.step}: ${result.detail}`,
    });
    return result;
  }

  /**
   * A disabled row (also one taken out of PANEL_OWNERS) must not keep its
   * game account's role: the lock would stop in-game :demote. Puts every
   * disabled row's linked account that isn't player back to player. Rows
   * already at player, and unreachable servers, are left for the next run.
   */
  async function reconcileDisabled(): Promise<number> {
    let fixed = 0;
    for (const row of store.listStaff()) {
      if (!row.disabled || !row.linkedSwid) continue;
      const who = await resolve(RECONCILE_ACTOR, row.linkedSwid);
      if (!who.ok || who.role === "player" || who.configAdmin) continue;
      const r = await syncRole(RECONCILE_ACTOR, row);
      if (r.ok) fixed++;
      console.log(`[PANEL] reconcile: ${row.email}'s game account ${who.username} (${who.role}) → player: ${r.ok ? "ok" : `${r.step}: ${r.detail}`}`);
    }
    return fixed;
  }

  return { resolve, syncRole, reconcileDisabled };
}

// The panel acting on its own (no staff member clicked anything).
export const RECONCILE_ACTOR: Actor = { email: "panel-reconcile", role: "owner", extras: [] };

export type RoleSync = ReturnType<typeof makeRoleSync>;
