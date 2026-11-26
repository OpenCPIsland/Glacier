import express from "express";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";
import * as push from "../../services/mixPush.ts";

const router = express.Router();

// =============================================================================
// Push Notification Endpoints (see services/mixPush.ts)
// =============================================================================

// Device tokens are random strings the app makes; 16-200 safe characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * POST /pushNotificationsSetting
 * Registers the device's push token. State is "ALL" or "ONLY_SILENT".
 */
router.post('/pushNotificationsSetting', authenticateMix, (req, res) => {
    const { PushToken, State } = req.body;
    const token = PushToken?.Token;
    const tokenType = PushToken?.TokenType;
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token) || typeof tokenType !== "string" ||
        (State !== "ALL" && State !== "ONLY_SILENT")) {
        return res.json({ Status: 'INVALID_REQUEST' });
    }
    push.register(req.mixUserId, token, tokenType, State);
    console.log(`[PUSH] ${req.mixUserId} registered a ${tokenType} device, state ${State}`);
    res.json(buildResponse());
});

/**
 * POST /pushNotificationsSetting/delete
 * Turns push off for the user.
 */
router.post('/pushNotificationsSetting/delete', authenticateMix, (req, res) => {
    push.unregisterUser(req.mixUserId);
    console.log(`[PUSH] ${req.mixUserId} deleted push settings`);
    res.json(buildResponse());
});

/**
 * GET /push/stream
 * The device's push stream (Server-Sent Events). Authenticated by the
 * device token in X-Mix-PushToken, which only its owner's registration
 * can create. 410 means "not registered for visible pushes, stop trying".
 */
router.get('/push/stream', (req, res) => {
    const token = req.headers['x-mix-pushtoken'];
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
        return res.status(410).json({ Status: 'NOT_REGISTERED' });
    }
    const lastEventId = Number(req.headers['last-event-id']);
    req.socket.setTimeout(0);
    req.socket.setKeepAlive?.(true);
    if (!push.openStream(token, Number.isSafeInteger(lastEventId) ? lastEventId : 0, res)) {
        return res.status(410).json({ Status: 'NOT_REGISTERED' });
    }
});

export default router;
