import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { hashUserId, buildResponse, generateId } from "./common.ts";
import crypto from "crypto";
import { buildRsaPublicKeyFromBytes } from "../../lib/crypto.ts";
const router = express.Router();

// =============================================================================
// Session Endpoints
// =============================================================================

/**
 * Build an RSA public key from modulus and exponent (Base64 encoded)
 * Returns a Node.js crypto KeyObject
 */
function buildRsaPublicKey(modulusBase64, exponentBase64) {
    return buildRsaPublicKeyFromBytes(
        Buffer.from(modulusBase64, 'base64'),
        Buffer.from(exponentBase64, 'base64')
    );
}

/**
 * PUT /session/user
 * Start user session
 * 
 * The client sends its RSA public key (modulus + exponent).
 * The server generates a symmetric key, encrypts it with the client's public key,
 * and returns it. The client decrypts it with its private key.
 */
router.put('/session/user', authenticateMix, (req, res) => {
    const { UserId, PublicKeyModulus, PublicKeyExponent, SessionGroupId, ProtocolVersion } = req.body;
    
    const sessionId = generateId();
    const hashedUserId = hashUserId(UserId);
    
    try {
        // Build the client's RSA public key from modulus and exponent
        const publicKey = buildRsaPublicKey(PublicKeyModulus, PublicKeyExponent);
        
        // Generate a 32-byte (256-bit) symmetric key for AES-256
        const symmetricKey = crypto.randomBytes(32);
        
        // Encrypt the symmetric key with the client's public key using PKCS#1 v1.5 padding
        const encryptedSymmetricKey = crypto.publicEncrypt(
            {
                key: publicKey,
                padding: crypto.constants.RSA_PKCS1_PADDING
            },
            symmetricKey
        );
        
        // Store session in database with the symmetric key for later use
        // The client token says which app this is (CPI or the Mix app), so
        // each app keeps its own session instead of replacing the other's.
        db.storeMixSession(UserId, sessionId, hashedUserId, symmetricKey, req.headers['x-mix-clienttoken'] ?? null);
        
        // Set presence to ACTIVE when session is created
        db.setMixPresenceState(UserId, 'ACTIVE');
        
        res.json(buildResponse({
            EncryptedSymmetricKey: encryptedSymmetricKey.toString('base64'),
            SessionId: sessionId,
            HashedUserId: hashedUserId
        }));
    } catch (err) {
        console.error('[MIX] Error creating session:', err.message);
        res.status(500).json({ Status: 'INTERNAL_ERROR', Message: err.message });
    }
});

/**
 * POST /session/user/delete
 * Delete user session
 */
router.post('/session/user/delete', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    // This is the SDK's logout: end the session and go offline. It must
    // not touch the user's friendships, invitations, alerts or pending
    // notifications; it used to delete them all, so every logout (CPI or
    // Mix) erased that player's half of their friends list.
    // End only the session this client is logging out of: the same account
    // may be signed in elsewhere (the Mix app and Club Penguin Island share
    // accounts). The SDK's logout is sent encrypted, so the session is named
    // by its header; without one, fall back to ending all of them.
    const sessionId = Number(req.headers['x-mix-usersessionid']);
    if (req.mixSessionSwid && Number.isSafeInteger(sessionId)) {
        db.deleteMixSessionById(sessionId);
    } else {
        db.deleteMixSession(UserId);
    }
    if (db.countMixSessions(UserId) === 0) {
        db.deleteMixPresenceState(UserId);
    }
    
    res.json(buildResponse());
});


export default router;
