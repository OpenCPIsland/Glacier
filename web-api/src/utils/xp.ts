/**
 * XP Utility Functions
 *
 * Handles mascot XP calculations and conversions.
 *
 * Internal XP format: 1,000,000 per level (level = floor(internalXp / 1,000,000)),
 * with the fraction being progress between that level's threshold and the next.
 */

import config from "../config.ts";

const INTERNAL_PER_LEVEL = 1_000_000;

// config.mascotXPThresholds comes from ProgressionMascotLevelXP.json.
// Each array is the CUMULATIVE raw XP at which level index i starts;
// the last entry is the max level (Rookie: 6, DJCadence: 3, others: 9).
function getThresholds(mascot: string): number[] {
    return config.mascotXPThresholds[mascot] ?? config.mascotXPThresholds.AuntArctic;
}

/**
 * Add raw XP to a mascot's internal XP value.
 *
 * @param {string} mascot - Mascot name (e.g., 'AuntArctic')
 * @param {number} rawXpToAdd - Raw XP amount to add
 * @param {number} currentInternalXp - Current internal XP value
 * @returns {number} New internal XP value (capped at the mascot's max level)
 */
export function addXpToInternal(mascot: string, rawXpToAdd: number, currentInternalXp: number): number {
    const t = getThresholds(mascot);
    const maxLevel = t.length - 1;
    const maxInternal = maxLevel * INTERNAL_PER_LEVEL;

    // Already at (or past) max level, or nothing to add
    if (currentInternalXp >= maxInternal) return maxInternal;
    if (!(rawXpToAdd > 0)) return currentInternalXp;

    // Internal -> cumulative raw XP
    const level = Math.floor(currentInternalXp / INTERNAL_PER_LEVEL);
    const fraction = (currentInternalXp - level * INTERNAL_PER_LEVEL) / INTERNAL_PER_LEVEL;
    const currentRaw = Math.round(t[level] + fraction * (t[level + 1] - t[level]));

    const newRaw = currentRaw + Math.floor(rawXpToAdd);

    // Reached the cap
    if (newRaw >= t[maxLevel]) return maxInternal;

    // Find the new level from raw thresholds (no float comparisons involved)
    let newLevel = level;
    while (t[newLevel + 1] <= newRaw) newLevel++;

    // Cumulative raw XP -> internal (ceil so the round-trip above is exact)
    const range = t[newLevel + 1] - t[newLevel];
    const fractionInternal = Math.min(
        Math.ceil(((newRaw - t[newLevel]) * INTERNAL_PER_LEVEL) / range),
        INTERNAL_PER_LEVEL - 1
    );

    return newLevel * INTERNAL_PER_LEVEL + fractionInternal;
}

/**
 * Get the current level from internal XP
 *
 * @param {number} internalXp - Internal XP value
 * @returns {number} Current level
 */
export function getLevelFromXp(internalXp: number): number {
    return Math.floor(internalXp / INTERNAL_PER_LEVEL);
}

/**
 * Get mascot name from quest ID prefix
 *
 * @param {string} questId - Quest ID (e.g., 'AAC001Q001LeakyShip')
 * @returns {string} Mascot name
 */
export function getMascotFromQuestId(questId: string): string {
    if (questId.startsWith('AAC')) return 'AuntArctic';
    if (questId.startsWith('DJC')) return 'DJCadence';
    if (questId.startsWith('RHC')) return 'Rockhopper';
    if (questId.startsWith('RKC')) return 'Rookie';
    if (questId.startsWith('GRY')) return 'Gary';
    return 'AuntArctic'; // Default
}

/**
 * Raise internal XP to at least the start of `minLevel` (never lowers it).
 * Used after a quest completes so that follow-up quests (preReqProgressLevel)
 * can never be soft-locked by quest XP alone being too low.
 *
 * @param {string} mascot - Mascot name
 * @param {number} currentInternalXp - Current internal XP value
 * @param {number} minLevel - Level (index) the player must have reached
 * @returns {number} Internal XP, >= minLevel * 1,000,000 (capped at max level)
 */
export function ensureMinLevel(mascot: string, currentInternalXp: number, minLevel: number): number {
    const maxLevel = getThresholds(mascot).length - 1;
    const target = Math.min(Math.max(minLevel, 0), maxLevel) * INTERNAL_PER_LEVEL;
    return Math.max(currentInternalXp, target);
}
