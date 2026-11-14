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

// What each prize id pays. Ids are LootTableRewardDefinition.Id values and
// the amounts are Coins.Amount from each prize's Reward asset.
const PRIZE_COINS = {
    'Seaweed': 2,
    'Small Fish 1': 5,
    'Small Fish 2': 5,
    'Cactus': 5,
    'Clam': 10,
    'Medium Fish 1': 10,
    'Medium Fish 2': 5,
    'Medium Fish 4': 10,
    'Medium Fish 5': 10,
    'Medium Fish 6': 5,
    'Medium Fish 7': 5,
    'Medium Fish 8': 10,
    'Medium Fish 3': 15,
    'Large Fish 1': 15,
    'Large Fish 2': 20,
    'Squid': 20,
    'Anchor': 35,
    'Venus Fly Trap': 45,
};

// The client (FishingController.onFishingResultReceived) reads the prize map
// with the fixed keys "Common", "Rare" and "Legendary" and needs all three.
// Each pool holds the prize names that rarity can offer. The values MUST be
// loot reward definition Ids from the client content. An unknown name does not
// throw: MinigameService.GetLootRewardDefinition silently falls back to the
// first definition, so every prize would look the same.
// Ids and weights come from the LootTableReward_* assets. Bucket mapping is
// inferred from the assets' bucket guids: 89fa... = Common, c82d... = Rare,
// 9863... = Legendary. The Quest bucket (88a6...) is deliberately left out.
const PRIZE_POOLS = {
    Common: [
        { id: 'Cactus',        weight: 4 },
        { id: 'Clam',          weight: 3 },
        { id: 'Medium Fish 1', weight: 3 },
        { id: 'Medium Fish 2', weight: 3 },
        { id: 'Medium Fish 4', weight: 3 },
        { id: 'Medium Fish 5', weight: 3 },
        { id: 'Medium Fish 6', weight: 3 },
        { id: 'Medium Fish 7', weight: 3 },
        { id: 'Medium Fish 8', weight: 3 },
        { id: 'Seaweed',       weight: 3 },
        { id: 'Small Fish 1',  weight: 3 },
        { id: 'Small Fish 2',  weight: 2 },
    ],
    Rare: [
        { id: 'Large Fish 1',  weight: 4 },
        { id: 'Large Fish 2',  weight: 4 },
        { id: 'Medium Fish 3', weight: 3 },
        { id: 'Squid',         weight: 5 },
    ],
    Legendary: [
        { id: 'Anchor',        weight: 6 },
        { id: 'Venus Fly Trap', weight: 4 },
    ],
};

// Weighted random pick of a prize id from a pool.
const pick = (pool) => {
    let roll = Math.random() * pool.reduce((sum, p) => sum + p.weight, 0);
    for (const p of pool) {
        roll -= p.weight;
        if (roll < 0) return p.id;
    }
    return pool[pool.length - 1].id;
};

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
