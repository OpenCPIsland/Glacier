/**
 * Catalog Routes
 * 
 * Handles clothing catalog browsing, submissions, and purchases.
 * 
 * Endpoints:
 * - GET  /catalog/v1/clothing/themes/stats        - Get current theme stats (GetCurrentThemeOperation)
 * - GET  /catalog/v1/clothing/user/stats          - Get user catalog stats (GetUserStatsOperation)
 * - POST /catalog/v1/clothing/items/:catalogSection - Get catalog items (BaseCatalogSectionOperation)
 * - POST /catalog/v1/clothing/purchase            - Purchase item (ItemPurchaseOperation)
 * - POST /catalog/v1/clothing/submit              - Submit item (ItemSubmissionOperation)
 */

import express from "express";
const router = express.Router();

// Daily theme challenge, driven by ClothingCatalogSchedules.json.
// The schedule has one entry per day (2017-02-21 .. 2019-07-09). 2018 is the one
// complete year (365 days), so today's month/day is looked up in 2018. That
// puts seasonal themes on the right dates every year.
import schedules from "../../data/ClothingCatalogSchedules.json";

// true: send the schedule entry's Id; false: send its CatalogThemeId.
// Test with schedule Id 7 (theme 65) to see which one the client expects.
const SEND_SCHEDULE_ID = true;
const SCHEDULE_YEAR = 2018;
const SUBMISSION_REWARD = 100;

const scheduleByDay = new Map<string, { Id: number; CatalogThemeId: number }>();
for (const s of schedules) {
    if (s.Year === SCHEDULE_YEAR) scheduleByDay.set(`${s.Month}-${s.Day}`, s);
}

function currentThemeId() {
    const now = new Date(); // UTC day; rolls over at 00:00 UTC
    let key = `${now.getUTCMonth() + 1}-${now.getUTCDate()}`;
    if (key === '2-29') key = '2-28'; // 2018 has no Feb 29
    const entry = scheduleByDay.get(key);
    if (!entry) return 1;
    return SEND_SCHEDULE_ID ? entry.Id : entry.CatalogThemeId;
}

import * as db from "../database.ts";
import * as smartfox from "../smartfoxNotifier.ts";
import { generateEquipmentId } from "../utils/session.ts";
import { NOT_ENOUGH_COINS } from "../utils/counts.ts";
import { templateCost } from "../utils/prices.ts";

// A catalog item always costs its equipment template's Cost from the game
// definitions, for old, current and new submissions alike; the stored cost
// is never used. null for a template the designer can't make.
function itemCost(s) {
    return templateCost(s.equipment?.definitionId);
}

// The client treats equipment.equipmentId !== 0 as "owned". Only a purchase
// owns a catalog item: buyers get the id of the copy they bought, everyone
// else (the creator included) gets 0 so the item shows as buyable.
function withOwnership(items, username) {
    const bought = db.getCatalogPurchases(username);
    return items.map(s => ({ ...s, cost: itemCost(s), equipment: { ...s.equipment, equipmentId: bought[s.clothingCatalogItemId] || 0 } }));
}

/**
 * GET /catalog/v1/clothing/themes/stats
 * Get current theme challenge stats
 * 
 * Response: CurrentThemeResponse { themes: CurrentThemeData[] }
 */
router.get('/catalog/v1/clothing/themes/stats', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} requested themes stats`);
    
    // mostPopularItem is the theme's icon and top seller on the catalog
    // home page: the most sold submission, newest first on a tie.
    const themeId = currentThemeId();
    const submissions = withOwnership(db.getCatalogSubmissions(themeId), username);
    const mostPopularItem = submissions.reduce((best, item) => !best
        || (item.numberSold || 0) > (best.numberSold || 0)
        || ((item.numberSold || 0) === (best.numberSold || 0) && (item.dateSubmitted || 0) > (best.dateSubmitted || 0)) ? item : best, null);
    
    // Response: CurrentThemeResponse
    res.json({
        themes: [{
            scheduledThemeChallengeId: themeId,
            userSubmissionClothingCatalogId: 0,
            mostPopularItem,
            submissionRewardCoinAmount: SUBMISSION_REWARD
        }]
    });
});

/**
 * GET /catalog/v1/clothing/user/stats
 * Get user catalog stats
 * 
 * Response: UserStatsResponse { totalItemsSold, totalItemsPurchased, mostPopularItem, currentItems }
 */
router.get('/catalog/v1/clothing/user/stats', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} requested user stats`);
    
    // Get user's catalog statistics
    const userSubmissions = withOwnership(db.getCatalogSubmissions ? 
        db.getCatalogSubmissions(null).filter(s => s.creatorName === username) : [], username);
    
    const totalItemsSold = userSubmissions.reduce((sum, item) => sum + (item.numberSold || 0), 0);
    
    // Response: UserStatsResponse
    res.json({
        totalItemsSold: totalItemsSold,
        totalItemsPurchased: Object.keys(db.getCatalogPurchases(username)).length,
        mostPopularItem: userSubmissions.length > 0 ? 
            userSubmissions.reduce((best, item) => 
                (item.numberSold || 0) > (best.numberSold || 0) ? item : best, userSubmissions[0]) : null,
        currentItems: userSubmissions.slice(0, 10)
    });
});

/**
 * POST /catalog/v1/clothing/items/:catalogSection
 * Get catalog items for a section (recent, popular, friends, category)
 * 
 * Response: CatalogSectionResponse { cursor, items }
 */
router.post('/catalog/v1/clothing/items/:catalogSection', (req, res) => {
    const { catalogSection } = req.params;
    const { username } = req.player;
    console.log(`[CATALOG] ${username} requested section: ${catalogSection}`);

    const themeId = req.body.scheduledThemeChallengeId || 0;
    let items = [...(db.getCatalogSubmissions?.(themeId === 0 ? null : themeId) ?? [])];

    if (catalogSection === 'recent') {
        items.sort((a, b) => (b.equipment?.dateTimeCreated || 0) - (a.equipment?.dateTimeCreated || 0));
    } else if (catalogSection === 'popular') {
        items.sort((a, b) => (b.numberSold || 0) - (a.numberSold || 0));
    } else if (catalogSection === 'friends') {
        items = items.filter(s => s.creatorName !== username); // TODO: real friends list
    }

    // Response: CatalogSectionResponse
    res.json({ cursor: '', items: withOwnership(items, username) });
});

/**
 * POST /catalog/v1/clothing/purchase
 * Purchase a clothing item from the catalog
 * 
 * Request: ItemPurchaseRequest { clothingCatalogItemId }
 * Response: ItemPurchaseResponse { clothingCatalogItemId, equipmentId, newCoinTotal, equipment }
 */
router.post('/catalog/v1/clothing/purchase', (req, res) => {
    const { swid, username } = req.player;
    const clothingCatalogItemId = req.body.clothingCatalogItemId;
    
    console.log(`[CATALOG] ${username} purchasing item: ${clothingCatalogItemId}`);
    
    // Find the catalog item
    const allSubmissions = db.getCatalogSubmissions ? db.getCatalogSubmissions(null) : [];
    const item = allSubmissions.find(s => s.clothingCatalogItemId === clothingCatalogItemId);
    
    if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
    }
    
    // Deduct cost and add equipment
    const cost = itemCost(item);
    if (cost === null) return res.status(400).json({ error: 'Item has no cost' });
    if (db.getPlayerCoins(username) < cost) return res.status(400).json({ code: NOT_ENOUGH_COINS });
    db.addPlayerCoins(username, -cost);
    
    // Create a copy of the equipment for the buyer
    const newEquipment = {
        equipmentId: generateEquipmentId(),
        dateTimeCreated: Date.now(),
        definitionId: item.equipment?.definitionId || 0,
        parts: item.equipment?.parts || []
    };
    
    db.saveEquipment(username, newEquipment);
    
    // Ensure the template is owned (so item shows in closet)
    if (newEquipment.definitionId) {
        db.addEquipmentTemplate(username, newEquipment.definitionId);
    }
    
    // Remember the purchase (marks the item owned on reload) and bump the sold counter
    db.recordCatalogPurchase(username, clothingCatalogItemId, newEquipment.equipmentId);
    
    console.log(`[CATALOG] ${username} purchased item ${clothingCatalogItemId} for ${cost} coins`);
    
    // Response: ItemPurchaseResponse
    res.json({
        clothingCatalogItemId: clothingCatalogItemId,
        equipmentId: newEquipment.equipmentId,
        newCoinTotal: db.getPlayerCoins(username),
        equipment: newEquipment
    });
});

/**
 * POST /catalog/v1/clothing/submit
 * Submit clothing to catalog
 * 
 * Request: ItemSubmissionRequest { scheduledThemeChallengeId, equipment }
 * Response: ItemSubmissionResponse { clothingCatalogItemId, newCoinTotal }
 */
router.post('/catalog/v1/clothing/submit', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} submitting clothing`);
    
    const scheduledThemeChallengeId = req.body.scheduledThemeChallengeId || 0;
    const equipment = req.body.equipment || {};
    
    const clothingCatalogItemId = generateEquipmentId();
    
    const newEquipment = {
        equipmentId: clothingCatalogItemId,
        dateTimeCreated: Date.now(),
        definitionId: equipment.definitionId || 0,
        parts: equipment.parts || []
    };
    const cost = itemCost({ equipment: newEquipment });
    if (cost === null) return res.status(400).json({ error: 'Item has no cost' });
    
    // A submission lists a design the player already made and creates no
    // item. The first one to the current theme challenge pays
    // SUBMISSION_REWARD (the client shows the coins as "rewarded"); it used
    // to pay every time and grant the template too.
    const themeNow = currentThemeId();
    const firstForTheme = scheduledThemeChallengeId === themeNow
        && !(db.getCatalogSubmissions?.(null) ?? []).some((x) => x.creatorName === username && x.scheduledThemeChallengeId === themeNow);
    if (firstForTheme) db.addPlayerCoins(username, SUBMISSION_REWARD);
    
    // Update catalog task
    if (db.updateDailyTask) {
        db.updateDailyTask(username, 'ClothingCatalogSubmission', 1, Date.now(), false);
    }
    
    if (db.addCatalogSubmission) {
        db.addCatalogSubmission(username, {
            clothingCatalogItemId,
            creatorName: username,
            cost,
            numberSold: 0,
            scheduledThemeChallengeId,
            dateSubmitted: Date.now(),
            equipment: newEquipment
        });
    }
    
    console.log(`[CATALOG] ${username} created item ${clothingCatalogItemId}`);
    
    // Get updated coin total
    const newCoinTotal = db.getPlayerCoins(username);
    
    smartfox.notifyDailyTaskUpdate(username, 'ClothingCatalogSubmission', 1);
    if (firstForTheme) smartfox.notifyCoinsUpdate(username, SUBMISSION_REWARD);
    
    // Response: ItemSubmissionResponse
    res.json({
        clothingCatalogItemId,
        newCoinTotal: newCoinTotal
    });
});

export default router;