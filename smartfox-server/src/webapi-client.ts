import { WEBAPI_INTERNAL_URL } from "./config.ts";
import { internalHeaders } from "./internal-secret.ts";
import { isRole, type Role } from "./commands/roles.ts";

// Server-to-server reward grants. The game server decides what was earned
// and tells the WebAPI directly, rather than trusting the client to relay
// it through PUT /reward/v1, which accepts anything a modified client sends.
// RewardGrant mirrors the `reward` argument of applyRewards in
// web-api/src/routes/reward.ts.
// Client-side CustomEquipment, as used by reward.add's "equipmentInstances".
export interface EquipmentInstanceGrant {
  equipmentId?: number; // assigned by the WebAPI
  dateTimeCreated?: number;
  definitionId: number;
  parts?: unknown[];
}

export interface RewardGrant {
  coins?: number;
  mascotXP?: Record<string, number>;
  equipmentTemplates?: number[];
  equipmentInstances?: EquipmentInstanceGrant[];
  decals?: number[];
  fabrics?: number[];
  durables?: number[];
  tubes?: number[];
  emotePacks?: string[];
  colourPacks?: string[];
  sizzleClips?: string[];
  collectibleCurrencies?: Record<string, number>;
}

export async function fetchIdentity(swid: string): Promise<{ username: string; role: Role; banned: boolean; mutedUntil: number | null } | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/identity`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ swid }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { username?: unknown; role?: unknown; banned?: unknown; mutedUntil?: unknown };
    if (typeof body.username !== "string") return null;
    const muted = typeof body.mutedUntil === "string" ? Date.parse(body.mutedUntil) : NaN;
    return { username: body.username, role: isRole(body.role) ? body.role : "player", banned: body.banned === true, mutedUntil: Number.isFinite(muted) ? muted : null };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: identity lookup failed: ${(err as Error).message}`);
    return null;
  }
}

/** The swids among `swids` with an active ban; null when the web API can't be asked. */
export async function fetchBanned(swids: string[]): Promise<string[] | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/banned`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ swids }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { banned?: unknown };
    return Array.isArray(body.banned) ? body.banned.filter((s): s is string => typeof s === "string") : null;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: ban check failed: ${(err as Error).message}`);
    return null;
  }
}
/**
 * Bans and active mutes (swid → until ISO) among `swids`. "unsupported"
 * when the web API predates the endpoint (use fetchBanned), null when it
 * can't be asked.
 */
export async function fetchModerationState(swids: string[]): Promise<{ banned: string[]; mutes: Record<string, string> } | "unsupported" | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/moderation-state`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ swids }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return "unsupported";
    if (!res.ok) return null;
    const body = (await res.json()) as { banned?: unknown; mutes?: unknown };
    if (!Array.isArray(body.banned) || typeof body.mutes !== "object" || body.mutes === null) return null;
    const mutes: Record<string, string> = {};
    for (const [swid, until] of Object.entries(body.mutes)) if (typeof until === "string") mutes[swid] = until;
    return { banned: body.banned.filter((s): s is string => typeof s === "string"), mutes };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: moderation check failed: ${(err as Error).message}`);
    return null;
  }
}

export type MuteRank = "moderator" | "admin";

/** Saves a mute. until (ms) when saved, "rank" when a higher rank's mute is active, "error" when it couldn't be saved. */
export async function saveMute(m: { swid: string; minutes: number; setBy: string; setByRank: MuteRank }): Promise<{ until: number } | "rank" | "error"> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/mute`, {
      method: "POST", headers: internalHeaders(), body: JSON.stringify(m), signal: AbortSignal.timeout(5000),
    });
    if (res.status === 403) return "rank";
    if (!res.ok) return "error";
    const until = Date.parse(((await res.json()) as { until?: unknown }).until as string);
    return Number.isFinite(until) ? { until } : "error";
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: saving a mute failed: ${(err as Error).message}`);
    return "error";
  }
}

export async function saveUnmute(m: { swid: string; by: string; byRank: MuteRank }): Promise<"lifted" | "none" | "rank" | "error"> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/unmute`, {
      method: "POST", headers: internalHeaders(), body: JSON.stringify(m), signal: AbortSignal.timeout(5000),
    });
    if (res.status === 403) return "rank";
    if (!res.ok) return "error";
    return ((await res.json()) as { lifted?: unknown }).lifted === true ? "lifted" : "none";
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: saving an unmute failed: ${(err as Error).message}`);
    return "error";
  }
}

export type SavedAppearance = { colour: number; tubeId: number; parts: unknown[] };

/** The colour, tube and worn outfit saved for a swid, or null when unknown or the request failed. */
export async function fetchAppearance(swid: string): Promise<SavedAppearance | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/appearance`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ swid }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<SavedAppearance>;
    if (!Number.isInteger(body.colour) || !Number.isInteger(body.tubeId) || !Array.isArray(body.parts)) return null;
    return { colour: body.colour!, tubeId: body.tubeId!, parts: body.parts };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: appearance request failed: ${(err as Error).message}`);
    return null;
  }
}

export type SetRoleResult = { ok: true; username: string } | { ok: false; reason: "unknown-user" | "config-admin" | "error" };

export async function setRole(username: string, role: Role): Promise<SetRoleResult> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/set-role`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ username, role }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { ok: false, reason: "unknown-user" };
    if (res.status === 409) return { ok: false, reason: "config-admin" };
    if (!res.ok) return { ok: false, reason: "error" };
    const body = (await res.json()) as { username?: unknown };
    return { ok: true, username: typeof body.username === "string" ? body.username : username };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: set-role failed: ${(err as Error).message}`);
    return { ok: false, reason: "error" };
  }
}

export async function grantReward(username: string, reward: RewardGrant): Promise<RewardGrant | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/grant-reward`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ username, reward }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: grant-reward for ${username} failed with status ${res.status}`);
      return null;
    }
    // The WebAPI echoes the reward with database ids filled in (equipment instances).
    const body = (await res.json().catch(() => null)) as { reward?: RewardGrant } | null;
    const granted = body?.reward ?? reward;
    console.log(`[${new Date().toISOString()}] webapi-client: granted reward to ${username}: ${JSON.stringify(granted)}`);
    return granted;
  } catch (err) {
    // A down WebAPI must not take the game server with it.
    console.log(`[${new Date().toISOString()}] webapi-client: grant-reward request failed: ${(err as Error).message}`);
    return null;
  }
}

// Records a completed quest objective and returns its reward from
// quests.json. Returns null if there's nothing to grant: no active quest,
// objective already recorded, no reward, or the request failed.
export async function grantQuestObjective(username: string, objective: string): Promise<RewardGrant | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/quest-objective`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ username, objective }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: quest-objective for ${username}/${objective} failed with status ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { reward: RewardGrant | null };
    return body.reward ?? null;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: quest-objective request failed: ${(err as Error).message}`);
    return null;
  }
}

// Tells the WebAPI the login of a join arrived, so the player counts as
// online until the connection closes (a join that never logs in only counts
// for a minute).
export async function reportSessionStarted(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/session-started`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ sessionId: Number(sessionId) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.log(`[${new Date().toISOString()}] webapi-client: session-started for ${sessionId} failed with status ${res.status}`);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: session-started request failed: ${(err as Error).message}`);
  }
}

// The sessions still connected here (session-heartbeat.ts), so the WebAPI
// keeps them online however long they last.
export async function reportSessionsAlive(sessionIds: number[]): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/sessions-alive`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ sessionIds }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.log(`[${new Date().toISOString()}] webapi-client: sessions-alive failed with status ${res.status}`);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: sessions-alive request failed: ${(err as Error).message}`);
  }
}

// Tells the WebAPI this room refused a login (the ROOM_CAP + headroom
// ceiling), so it treats the room as full for a minute and the client's
// room-full retry isn't sent straight back into it.
export async function reportRoomFull(roomName: string): Promise<void> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/room-full`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ room: roomName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.log(`[${new Date().toISOString()}] webapi-client: room-full failed with status ${res.status}`);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: room-full request failed: ${(err as Error).message}`);
  }
}

export async function fetchRoomCollected(username: string, room: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/room-collected`, {
      method: "POST", headers: internalHeaders(), body: JSON.stringify({ username, room }), signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { collected?: unknown };
    return body.collected && typeof body.collected === "object" ? (body.collected as Record<string, number>) : null;
  } catch { return null; }
}

// At startup: connections from before this process are gone and their close
// was never reported, so the WebAPI forgets all sessions. Retried, since the
// WebAPI may still be starting (both restart together on a deploy).
export async function resetSessions(): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/sessions-reset`, {
        method: "POST",
        headers: internalHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      console.log(`[${new Date().toISOString()}] webapi-client: sessions-reset answered ${res.status}`);
    } catch (err) {
      console.log(`[${new Date().toISOString()}] webapi-client: sessions-reset attempt ${attempt} failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Tells the WebAPI a connection closed, so the player stops showing as
// online in friend and player-card lookups. sessionId is the
// joinRoomData sessionId the WebAPI issued for this room join.
export async function reportSessionEnded(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/session-ended`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ sessionId: Number(sessionId) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.log(`[${new Date().toISOString()}] webapi-client: session-ended for ${sessionId} failed with status ${res.status}`);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: session-ended request failed: ${(err as Error).message}`);
  }
}

// Counts a daily task event (daily-tasks.ts). The WebAPI applies it and
// returns the task's counter; changed is false when CounterMax was already
// reached, completed is true when this made the task complete.
export interface TaskIncrementResult {
  counter: number;
  changed: boolean;
  completed: boolean;
}

export async function incrementTask(username: string, taskId: string, times: number): Promise<TaskIncrementResult | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/task-increment`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ username, taskId, times }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: task-increment for ${username}/${taskId} failed with status ${res.status}`);
      return null;
    }
    return (await res.json()) as TaskIncrementResult;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: task-increment request failed: ${(err as Error).message}`);
    return null;
  }
}

// Party state kept by the web API (calendar plus admin override).
export interface PartyState {
  mode: "auto" | "party" | "none";
  party: string | null;
  active: string[];
}

function asPartyState(v: unknown): PartyState | null {
  const b = v as Partial<PartyState> | null;
  if (!b || typeof b !== "object") return null;
  if (b.mode !== "auto" && b.mode !== "party" && b.mode !== "none") return null;
  if (b.party !== null && typeof b.party !== "string") return null;
  if (!Array.isArray(b.active) || !b.active.every((k) => typeof k === "string")) return null;
  return { mode: b.mode, party: b.party, active: b.active };
}

export async function fetchParty(): Promise<PartyState | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/party`, { headers: internalHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return asPartyState(await res.json());
  } catch {
    return null;
  }
}

export type PartyOverrideResult =
  | { ok: true; state: PartyState }
  | { ok: false; reason: "unknown-party" | "bad-mode" | "error"; valid?: string[] };

export async function setPartyOverride(body: { mode: string; party?: string; setBy: string }): Promise<PartyOverrideResult> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/party-override`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json().catch(() => null)) as { error?: string; valid?: unknown } | null;
    if (res.ok) {
      const state = asPartyState(json);
      return state ? { ok: true, state } : { ok: false, reason: "error" };
    }
    if (res.status === 400 && json?.error === "unknown party") {
      return { ok: false, reason: "unknown-party", valid: Array.isArray(json.valid) ? json.valid.filter((v): v is string => typeof v === "string") : undefined };
    }
    if (res.status === 400 && json?.error === "bad mode") return { ok: false, reason: "bad-mode" };
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
