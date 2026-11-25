/**
 * Response Helper Functions
 *
 * Standard response formats used by the game client.
 */

import config from "../config.ts";
import { getLevelFromXp } from "./xp.ts";

/**
 * Create a signed response wrapper
 * Used for most API responses that the game client expects
 *
 * @param {*} data - Response data
 * @param {string} swid - Player SWID (optional, uses placeholder if not provided)
 * @returns {object} Signed response object
 */
export function signedResponse(data: unknown, swid: string | null = null) {
    return {
        goodUntil: Date.now() + 100000,
        swid: swid || '{SWID}',
        data: data,
        signature: 'mock_signature'
    };
}

/**
 * Build QuestStateCollection for response
 *
 * @param {Array} quests - Array of quest objects
 * @returns {Array} Formatted quest state collection
 */
export function buildQuestStateCollection(quests: any[]) {
    return quests.map(q => ({
        questId: q.questId,
        status: q.status,
        completedObjectives: q.completedObjectives || [],
        unlockTime: q.unlockTime || null,
        timesCompleted: q.timesCompleted || 0
    }));
}

/**
 * Add quests the player can now start (level requirement and prerequisites
 * met, not yet in the database) as AVAILABLE entries. Same rules as the
 * room-join quest collection, so the client learns about newly unlocked
 * quests without having to rejoin.
 *
 * @param {Array} quests - Quests from the database
 * @param {object} mascotXP - Player's internal mascot XP by mascot
 * @returns {Array} Quests plus newly available ones
 */
export function withAvailableQuests(quests: any[], mascotXP: Record<string, number>) {
    const known = new Set(quests.map(q => q.questId));
    const completed = new Set(
        quests.filter(q => q.status === QuestStatus.COMPLETED || q.timesCompleted > 0).map(q => q.questId)
    );
    const result = [...quests];

    for (const [questId, def] of Object.entries(config.questDefinitions as Record<string, any>)) {
        if (known.has(questId)) continue;
        if (getLevelFromXp(mascotXP[def.mascot] || 0) < (def.levelRequirement || 0)) continue;
        if (!(def.prerequisites || []).every((p: string) => completed.has(p))) continue;
        result.push({
            questId,
            status: QuestStatus.AVAILABLE,
            completedObjectives: [],
            timesCompleted: 0,
            unlockTime: null,
            completedTime: null
        });
    }
    return result;
}

/**
 * Quest status enum values
 */
export const QuestStatus = {
    AVAILABLE: 0,
    ACTIVE: 1,
    SUSPENDED: 2,
    COMPLETED: 3,
    LOCKED: 4
};
