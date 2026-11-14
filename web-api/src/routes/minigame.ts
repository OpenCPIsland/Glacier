/**
 * Minigame Routes
 *
 * Handles minigame operations like fishing.
 *
 * Endpoints:
 * - POST /minigame/v1/fishing/cast  - Cast fishing rod (FishingCastOperation)
 * - POST /minigame/v1/fishing/catch - Catch fish (FishingCatchOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";

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

// What each prize id pays.
const PRIZE_COINS = { fish_common: 10, fish_rare: 25, fish_epic: 50, coins_10: 10, coins_25: 25, coins_50: 50 };

// The client (FishingController.onFishingResultReceived) reads the prize map
// with the fixed keys "Common", "Rare" and "Legendary" and needs all three.
// Each pool holds the prize names that rarity can offer. The values MUST be
// loot reward definition names that exist in the client content, otherwise
// setupFishing() throws and no fish spawn.
const PRIZE_POOLS = {
    Common:    ['fish_common', 'coins_10'],
    Rare:      ['fish_rare',   'coins_25'],
    Legendary: ['fish_epic',   'coins_50'],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Web service event types (shared contract with
// smartfox-server/src/handlers/web-service-event.ts)
const WS_EVENT_FISHING = 1;

// Each player's last cast: the prize ids it offered. A catch must name one
// of them, within CAST_TTL_MS, and uses the cast up.
const CAST_TTL_MS = 5 * 60_000;
// A scripted client could cast and catch nonstop; the minigame takes
// seconds to play. A catch sooner than FISHING_MIN_CATCH_MS after its cast
// pays nothing, and casts closer than FISHING_MIN_CAST_MS are refused.
const MIN_CATCH_MS = Number(process.env.FISHING_MIN_CATCH_MS ?? 3000);
const MIN_CAST_MS = Number(process.env.FISHING_MIN_CAST_MS ?? 5000);
const lastCast = new Map<string, { prizes: Set<string>; at: number }>();
const lastCastAt = new Map<string, number>();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of lastCast) if (now - v.at > CAST_TTL_MS) lastCast.delete(k);
    for (const [k, at] of lastCastAt) if (now - at > MIN_CAST_MS) lastCastAt.delete(k);
}, 60_000).unref?.();

/**
 * POST /minigame/v1/fishing/cast
 * Cast the fishing rod
 *
 * Request: SignedResponse<InWorldState>
 * Response: SignedResponse<FishingResult> { availablePrizeMap }
 *
 * availablePrizeMap must be exactly { Common, Rare, Legendary } -> prize name.
 */
router.post('/minigame/v1/fishing/cast', (req, res) => {
    const { swid, username } = req.player;
    const previous = lastCastAt.get(username);
    if (previous !== undefined && Date.now() - previous < MIN_CAST_MS) {
        return res.status(429).json({ code: 'CAST_TOO_SOON' });
    }

    console.log(`[MINIGAME] ${username} casting fishing rod`);

    // One prize per rarity, keyed by the rarity names the client expects
    const availablePrizeMap = {
        Common:    pick(PRIZE_POOLS.Common),
        Rare:      pick(PRIZE_POOLS.Rare),
        Legendary: pick(PRIZE_POOLS.Legendary),
    };

    lastCast.set(username, { prizes: new Set(Object.values(availablePrizeMap)), at: Date.now() });
    lastCastAt.set(username, Date.now());

    // Response: SignedResponse<FishingResult>
    res.json(signedResponse({
        availablePrizeMap: availablePrizeMap
    }, swid));
});

/**
 * POST /minigame/v1/fishing/catch
 * Catch a fish (complete fishing minigame)
 *
 * Request: FishingCatchRequest { fishingCastResult, winningRewardName }
 * Response: FishingCatchResponse { rewards, wsEvents }
 */
router.post('/minigame/v1/fishing/catch', (req, res) => {
    const { swid, username } = req.player;
    const catchRequest = req.body;
    const winningRewardName = typeof catchRequest?.winningRewardName === 'string' ? catchRequest.winningRewardName : '';
    const cast = lastCast.get(username);
    const age = cast ? Date.now() - cast.at : Infinity;
    const offered = !!cast && age >= MIN_CATCH_MS && age <= CAST_TTL_MS && cast.prizes.has(winningRewardName);
    if (cast) lastCast.delete(username);
    const coinReward = offered && Object.hasOwn(PRIZE_COINS, winningRewardName) ? PRIZE_COINS[winningRewardName] : 0;

    // Add coins to player
    if (coinReward > 0) db.addPlayerCoins(username, coinReward);

    // Build reward structure
    const reward = {
        coins: coinReward
    };

    // Response: FishingCatchResponse
    // wsEvents is forwarded by the client to the game server as wsevent.1,
    // which turns it into fishing challenge progress. Only valid catches
    // get one. Each entry is signed on its own.
    res.json({
        rewards: signedResponse({
            rewards: {
                [swid]: reward
            },
            source: 'MINI_GAME',
            sourceId: 'fishing'
        }, swid),
        wsEvents: offered
            ? [signedResponse({ type: WS_EVENT_FISHING, details: winningRewardName }, swid)]
            : []
    });
});

export default router;