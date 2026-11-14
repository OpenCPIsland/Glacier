/**
 * Moderation Routes
 * 
 * Handles player reporting and moderation.
 * 
 * Endpoints:
 * - POST /moderation/v1/report/name/:displayName - Report a player (ReportPlayerOperation)
 */

import express from "express";
import * as db from "../database.ts";
import { report } from "../services/moderation.ts";
import { logSafe } from "../utils/logSafe.ts";
const router = express.Router();

/**
 * The report reason from the request body. The real client sends the bare
 * text (ChatSwearing); a quoted JSON string and {"reason": "..."} are accepted
 * too. Undefined when there is no usable text.
 */
function reasonFrom(body: unknown, rawBody: unknown): string | undefined {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
        const r = (body as { reason?: unknown }).reason;
        return typeof r === 'string' && r.trim() ? r.trim() : undefined;
    }
    const text = (typeof body === 'string' ? body : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : '').trim();
    if (!text) return undefined;
    try {
        const v = JSON.parse(text);
        if (typeof v === 'string') return v.trim() || undefined;
        if (v !== null && typeof v === 'object') {
            const r = (v as { reason?: unknown }).reason;
            return typeof r === 'string' && r.trim() ? r.trim() : undefined;
        }
    } catch { /* not JSON: the bare text is the reason */ }
    return text;
}

/**
 * POST /moderation/v1/report/name/:displayName
 * Report a player
 *
 * Request: reason as the body (bare text from the real client)
 * Response: 200 OK (empty)
 */
router.post('/moderation/v1/report/name/:displayName', (req, res) => {
    const { swid, username } = req.player;
    const reportedPlayer = req.params.displayName;

    const reason = reasonFrom(req.body, req.rawBody);
    if (reason === undefined) {
        console.log(`[MODERATION] Invalid report body from ${username}: ${logSafe(req.body)}`);
        return res.status(400).json({ error: 'Invalid report body' });
    }

    // Resolve the name to a swid. An unknown name is still accepted (and
    // stored as "name:<displayName>") so the reply never confirms whether
    // an account exists.
    const target = db.getPlayerByDisplayName(reportedPlayer);
    const id = report({ reporter: swid, reported: target?.swid ?? `name:${reportedPlayer}`, reason: String(reason), source: "cpi" });
    console.log(`[MODERATION] Report ${id}: ${username} reported ${logSafe(reportedPlayer)}: ${logSafe(reason)}`);

    res.status(200).send();
});

export default router;
