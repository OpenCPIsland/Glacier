// Room-chat log for the admin panel (sub-project 2b). POST
// /chat/v1/message/verify records every message here: it is the one place
// that sees both what the player typed and what the filter made of it.
// The log says what was submitted and how the filter and mutes treated it,
// not whether the game server relayed it. Mix DM threads are not logged.
import * as database from "../database.ts";
import { activeMute } from "./moderation.ts";
import { logSafe } from "../utils/logSafe.ts";

const sql = database.db;

export type ChatStatus = "sent" | "masked" | "blocked" | "muted";
export type ChatRow = {
    id: number; swid: string; username: string; room: string | null; world: string | null;
    original: string; shown: string; status: ChatStatus; createdAt: string;
};

export const PAGE_SIZE = 100;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_KEY = "chat_log_retention_days";
const PURGE_BATCH = 1000;

// Verify is a plain authenticated web API call: it needs no game server, so
// one account could otherwise log hundreds of rows a minute. Past the cap the
// route refuses to sign (429): a signed message is relayed, so a signed but
// unlogged one would let a flooder evade moderation.
export const MAX_LOGGED_PER_MINUTE = 60;
const windows = new Map<string, { start: number; count: number }>();
/** Counts one verify call for this account; false once it is over the cap for the current minute. */
export function allowChat(swid: string, now = Date.now()): boolean {
    if (windows.size > 10_000) for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
    let w = windows.get(swid);
    if (!w || now - w.start >= 60_000) { w = { start: now, count: 0 }; windows.set(swid, w); }
    return ++w.count <= MAX_LOGGED_PER_MINUTE;
}

/** Never throws: a failed insert must not fail the chat verify response. */
export function recordChat(e: {
    swid: string; username: string; senderSessionId: unknown;
    original: string; shown: string; moderated: boolean; blocked: boolean;
}): void {
    if (e.original === "") return;
    try {
        const status: ChatStatus = activeMute(e.swid) ? "muted" : e.blocked ? "blocked" : e.moderated ? "masked" : "sent";
        let place: { room_name: string | null; world: string | null } | null = null;
        if (Number.isSafeInteger(e.senderSessionId)) {
            place = sql.query("SELECT room_name, world FROM player_sessions WHERE session_id = ? AND swid = ?")
                .get(e.senderSessionId as number, e.swid) as typeof place;
        }
        place ??= sql.query("SELECT room_name, world FROM player_sessions WHERE swid = ? ORDER BY last_activity DESC, session_id DESC LIMIT 1")
            .get(e.swid) as typeof place;
        sql.query("INSERT INTO chat_log (swid, username, room, world, original, shown, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(e.swid, e.username, place?.room_name ?? null, place?.world ?? null, e.original, e.shown, status, new Date().toISOString());
    } catch (err) {
        // The error text can quote SQL values, so only its class is logged.
        console.error(`[CHAT-LOG] insert failed: ${logSafe((err as Error)?.name ?? "error", 60)}`);
    }
}

export function getRetentionDays(): number {
    const n = Number(database.getSetting(RETENTION_KEY));
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_RETENTION_DAYS;
}

export function setRetentionDays(days: number): void {
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) {
        throw new RangeError("retention must be a whole number of days from 1 to 365");
    }
    database.setSetting(RETENTION_KEY, String(days));
}

/** Deletes rows older than the retention setting, in batches. Returns the count. */
export function purgeChatLog(now = Date.now()): number {
    const cutoff = new Date(now - getRetentionDays() * 86_400_000).toISOString();
    let total = 0;
    for (;;) {
        const { changes } = sql.run("DELETE FROM chat_log WHERE id IN (SELECT id FROM chat_log WHERE created_at < ? LIMIT ?)", [cutoff, PURGE_BATCH]);
        total += changes;
        if (changes < PURGE_BATCH) return total;
    }
}

const COLS = "id, swid, username, room, world, original, shown, status, created_at AS createdAt";

function page(where: string, args: (string | number)[], before: number | undefined): { rows: ChatRow[]; next: number | null } {
    const cond = before !== undefined ? `${where} AND id < ?` : where;
    const rows = sql.query(`SELECT ${COLS} FROM chat_log WHERE ${cond} ORDER BY id DESC LIMIT ?`)
        .all(...args, ...(before !== undefined ? [before] : []), PAGE_SIZE + 1) as ChatRow[];
    const more = rows.length > PAGE_SIZE;
    if (more) rows.pop();
    return { rows, next: more ? rows[rows.length - 1]!.id : null };
}

export function queryByPlayer(swid: string, before?: number): { rows: ChatRow[]; next: number | null } {
    return page("swid = ?", [swid], before);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** from/to are ISO timestamps (from inclusive, to exclusive). */
export function querySearch(q: { room?: string; from: string; to: string; text?: string; before?: number }): { rows: ChatRow[]; next: number | null } {
    const where = ["created_at >= ?", "created_at < ?"];
    const args: string[] = [q.from, q.to];
    if (q.room !== undefined) { where.push("room = ?"); args.push(q.room); }
    if (q.text !== undefined) {
        where.push("(original LIKE ? ESCAPE '\\' OR shown LIKE ? ESCAPE '\\')");
        const like = `%${likeEscape(q.text)}%`;
        args.push(like, like);
    }
    return page(where.join(" AND "), args, q.before);
}
