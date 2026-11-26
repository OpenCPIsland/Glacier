// Mix push notifications, sent by this server directly (no Google or Apple).
//
// The Android app registers a random device token through
// POST /pushNotificationsSetting (TokenType "GLACIER"), then a background
// service keeps GET /push/stream open: a Server-Sent Events stream of the
// pushes for that device. A push for a device that isn't connected waits
// in mix_push_outbox; when the device reconnects it sends the last event
// id it saw (Last-Event-ID) and gets everything after it.
//
// Payloads use the field names the client SDK parses
// (PushNotificationReceiver.Receive): type, chatThreadId, chatMessageId,
// friendshipInvitationId, friendId. title and body are what the Android
// notification shows.
import type { Response } from "express";
import * as db from "../database.ts";

const sql = db.db;

/** The only token type this server delivers to. GCM and APNS are dead. */
export const GLACIER_TOKEN_TYPE = "GLACIER";

/** How long an undelivered push waits for its device. */
const OUTBOX_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** At most this many waiting pushes per device; older ones are dropped. */
const OUTBOX_MAX_PER_DEVICE = 100;
/** A comment line this often keeps the connection (and NAT entries) alive. */
export const HEARTBEAT_MS = 45_000;

sql.exec(`
    CREATE TABLE IF NOT EXISTS mix_push_devices (
        token TEXT PRIMARY KEY,
        swid TEXT NOT NULL,
        token_type TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )
`);
sql.exec(`CREATE INDEX IF NOT EXISTS idx_mix_push_devices_swid ON mix_push_devices (swid)`);
sql.exec(`
    CREATE TABLE IF NOT EXISTS mix_push_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )
`);
sql.exec(`CREATE INDEX IF NOT EXISTS idx_mix_push_outbox_token ON mix_push_outbox (token, id)`);

/** A device that hasn't registered or connected for this long is forgotten. */
const DEVICE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

// Expired pushes and devices (a logout leaves its old token behind).
function cleanup(): void {
    const now = Date.now();
    sql.query(`DELETE FROM mix_push_outbox WHERE created_at < ?`).run(now - OUTBOX_TTL_MS);
    sql.query(`DELETE FROM mix_push_devices WHERE updated_at < ?`).run(now - DEVICE_TTL_MS);
    sql.query(`DELETE FROM mix_push_outbox WHERE token NOT IN (SELECT token FROM mix_push_devices)`).run();
}
cleanup();
setInterval(cleanup, 60 * 60 * 1000).unref?.();

type Device = { token: string; swid: string; token_type: string; state: string };
type Stream = { res: Response; lastSentId: number; heartbeat: ReturnType<typeof setInterval> };

/** Open streams by device token. One per device; a reconnect replaces it. */
const streams = new Map<string, Stream>();

export type PushPayload = {
    type: string;
    title: string;
    body: string;
    [k: string]: string;
};

// ---------------------------------------------------------------------------
// Registration (POST /pushNotificationsSetting and its delete)

/** State is "ALL" (visible pushes) or "ONLY_SILENT" (none; we send no silent ones). */
export function register(swid: string, token: string, tokenType: string, state: string): void {
    // A device handed to another account must not get the old one's pushes.
    const previous = device(token);
    if (previous && previous.swid !== swid) {
        sql.query(`DELETE FROM mix_push_outbox WHERE token = ?`).run(token);
        stopStream(token);
    }
    sql.query(`INSERT INTO mix_push_devices (token, swid, token_type, state, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET swid = excluded.swid, token_type = excluded.token_type,
            state = excluded.state, updated_at = excluded.updated_at`)
        .run(token, swid, tokenType, state, Date.now());
    if (state !== "ALL") stopStream(token);
}

/**
 * The SDK's delete call names only the user, not the device, so this
 * removes all of the user's devices. Their streams are told to stop.
 */
export function unregisterUser(swid: string): void {
    const tokens = (sql.query(`SELECT token FROM mix_push_devices WHERE swid = ?`).all(swid) as { token: string }[]).map((r) => r.token);
    for (const token of tokens) {
        sql.query(`DELETE FROM mix_push_outbox WHERE token = ?`).run(token);
        stopStream(token);
    }
    sql.query(`DELETE FROM mix_push_devices WHERE swid = ?`).run(swid);
}

function device(token: string): Device | null {
    return sql.query(`SELECT token, swid, token_type, state FROM mix_push_devices WHERE token = ?`).get(token) as Device | null;
}

// ---------------------------------------------------------------------------
// Sending

/**
 * Queues a push for every device of `swid` that wants visible pushes and
 * delivers it to the ones connected. Safe inside inTransaction: the outbox
 * rows roll back with it, and delivery runs after the transaction (a
 * microtask), reading only rows that were committed.
 */
export function pushTo(swid: string, payload: PushPayload): void {
    const devices = sql.query(`SELECT token FROM mix_push_devices WHERE swid = ? AND state = 'ALL' AND token_type = ?`)
        .all(swid, GLACIER_TOKEN_TYPE) as { token: string }[];
    if (devices.length === 0) return;
    const json = JSON.stringify(payload);
    const now = Date.now();
    for (const { token } of devices) {
        sql.query(`INSERT INTO mix_push_outbox (token, payload, created_at) VALUES (?, ?, ?)`).run(token, json, now);
        sql.query(`DELETE FROM mix_push_outbox WHERE token = ? AND id NOT IN
            (SELECT id FROM mix_push_outbox WHERE token = ? ORDER BY id DESC LIMIT ?)`).run(token, token, OUTBOX_MAX_PER_DEVICE);
        queueMicrotask(() => flush(token));
    }
}

/** Sends a connected device every waiting push it hasn't been sent yet. */
function flush(token: string): void {
    const stream = streams.get(token);
    if (!stream) return;
    const rows = sql.query(`SELECT id, payload FROM mix_push_outbox WHERE token = ? AND id > ? ORDER BY id`)
        .all(token, stream.lastSentId) as { id: number; payload: string }[];
    for (const row of rows) {
        stream.res.write(`id: ${row.id}\ndata: ${row.payload}\n\n`);
        stream.lastSentId = row.id;
    }
}

// ---------------------------------------------------------------------------
// The stream (GET /push/stream)

/**
 * Opens the SSE stream for a device. `lastEventId` is the last push the
 * device received: everything up to it is deleted, the rest is sent now.
 * Returns false (and sends nothing) when the token isn't registered for
 * visible pushes; the caller answers 410 so the app stops its service.
 */
export function openStream(token: string, lastEventId: number, res: Response): boolean {
    const d = device(token);
    if (!d || d.state !== "ALL" || d.token_type !== GLACIER_TOKEN_TYPE) return false;

    sql.query(`DELETE FROM mix_push_outbox WHERE token = ? AND (id <= ? OR created_at < ?)`)
        .run(token, lastEventId, Date.now() - OUTBOX_TTL_MS);
    sql.query(`UPDATE mix_push_devices SET updated_at = ? WHERE token = ?`).run(Date.now(), token);

    const previous = streams.get(token);
    if (previous) closeStream(token, previous);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    // Tells the client how long to wait before reconnecting after a drop.
    res.write(`retry: 5000\n: connected\n\n`);

    const stream: Stream = {
        res,
        lastSentId: lastEventId,
        heartbeat: setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS),
    };
    streams.set(token, stream);
    res.on("close", () => {
        clearInterval(stream.heartbeat);
        if (streams.get(token) === stream) streams.delete(token);
    });
    flush(token);
    return true;
}

function closeStream(token: string, stream: Stream): void {
    clearInterval(stream.heartbeat);
    streams.delete(token);
    stream.res.end();
}

/** Tells a connected device to stop its service (push turned off or moved). */
function stopStream(token: string): void {
    const stream = streams.get(token);
    if (!stream) return;
    stream.res.write(`event: stop\ndata: {}\n\n`);
    closeStream(token, stream);
}

// ---------------------------------------------------------------------------
// Payload builders for the events that show a notification

function displayName(swid: string): string {
    const player = db.getPlayerBySwid(swid);
    return player?.displayName || player?.username || "Someone";
}

const MESSAGE_PUSH_TYPE: Record<string, string> = {
    TEXT: "TEXT_MESSAGE",
    STICKER: "STICKER_MESSAGE",
    GAG: "GAG_MESSAGE",
    GAME_STATE: "GAME_STATE_MESSAGE",
};

/** A new chat message, for every recipient except its sender. */
export function pushChatMessage(message: any, recipients: string[]): void {
    const pushType = MESSAGE_PUSH_TYPE[message.MessageType];
    if (!pushType) return;
    const sender = String(message.SenderUserId);
    const name = displayName(sender);
    const thread = sql.query(`SELECT type FROM mix_chat_threads WHERE id = ?`).get(message.ChatThreadId) as { type: string } | null;
    const title = thread?.type === "GROUP" ? `${name} (group chat)` : name;
    let body: string;
    switch (message.MessageType) {
        case "TEXT": body = String(message.Text ?? ""); break;
        case "STICKER": body = "Sent a sticker"; break;
        case "GAG": body = "Sent a gag"; break;
        default: body = "Wants to play a game"; break;
    }
    const payload: PushPayload = {
        type: pushType,
        title,
        body,
        chatThreadId: String(message.ChatThreadId),
        chatMessageId: String(message.ChatMessageId),
    };
    for (const swid of recipients) {
        if (swid !== sender) pushTo(swid, payload);
    }
}

/** A friend request, for the invitee. */
export function pushFriendshipInvitation(inviteeSwid: string, inviterSwid: string, invitationId: number | string): void {
    pushTo(inviteeSwid, {
        type: "FRIENDSHIP_INVITATION_MESSAGE",
        title: "New friend request",
        body: `${displayName(inviterSwid)} wants to be your friend`,
        friendshipInvitationId: String(invitationId),
    });
}

/** An accepted friend request, for the one who sent it. */
export function pushFriendshipAdded(inviterSwid: string, accepterSwid: string): void {
    pushTo(inviterSwid, {
        type: "FRIENDSHIP_MESSAGE",
        title: "Friend request accepted",
        body: `${displayName(accepterSwid)} is now your friend`,
        friendId: accepterSwid,
    });
}
