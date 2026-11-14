/**
 * Chat Routes
 * 
 * Handles chat message verification and moderation.
 * 
 * Endpoints:
 * - POST /chat/v1/message/verify - Verify/moderate chat message (VerifyChatMessageOperation)
 */

import express from "express";
import { filterText } from "../services/moderation.ts";
import { signChat, MAX_CHAT_LENGTH } from "../utils/chatSignature.ts";
import { logSafe } from "../utils/logSafe.ts";
import { allowChat, recordChat } from "../services/chatLog.ts";
const router = express.Router();

/**
 * Wrap response in SignedResponse format
 */
function signedResponse(data, swid) {
    return {
        goodUntil: Date.now() + 3600000,
        swid: swid || '',
        data: data,
        signature: 'server_signature'
    };
}

/**
 * POST /chat/v1/message/verify
 * Verify/moderate a chat message
 * 
 * Request: ChatMessage { senderSessionId, message, emotion, moderated, questId, objective }
 * Response: SignedResponse<ChatMessage>
 */
router.post('/chat/v1/message/verify', (req, res) => {
    const { swid, username } = req.player;
    const chatMessage = req.body;
    
    console.log(`[CHAT] ${username} verifying message: ${logSafe(chatMessage?.message)}`);
    
    // Nothing is signed that the chat log would not record (services/chatLog.ts).
    if (!allowChat(swid)) {
        res.set("Retry-After", "60");
        return res.status(429).json({ error: "Too many chat messages. Wait a minute." });
    }

    const raw = typeof chatMessage.message === "string" ? chatMessage.message : "";
    if ([...raw].length > MAX_CHAT_LENGTH) {
        return res.status(400).json({ error: `Chat messages are at most ${MAX_CHAT_LENGTH} characters` });
    }
    // The shared filter (services/moderation.ts) masks matched words; a
    // blocked message comes back fully masked.
    const { text, moderated, blocked } = filterText(raw);

    recordChat({ swid, username, senderSessionId: chatMessage.senderSessionId, original: raw, shown: text, moderated, blocked });

    const verifiedMessage = {
        senderSessionId: chatMessage.senderSessionId,
        message: text,
        emotion: Number.isInteger(chatMessage.emotion) ? chatMessage.emotion : 0,
        moderated: moderated || blocked,
        questId: chatMessage.questId || '',
        objective: chatMessage.objective || ''
    };
    
    // Response: SignedResponse<ChatMessage>, signed so the SmartFox server
    // relays only filtered text from this player (utils/chatSignature.ts).
    const { goodUntil, signature } = signChat(swid, verifiedMessage);
    res.json({ goodUntil, swid, data: verifiedMessage, signature });
});

export default router;
