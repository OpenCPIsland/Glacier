/**
 * XP Utility Functions
 *
 * Handles mascot XP calculations and conversions.
 */

import config from "../config.ts";

/**
 * Convert raw XP to internal XP format (1,000,000 per level)
 * The client uses: level = internalXP / 1,000,000
 *
 * @param {string} mascot - Mascot name (e.g., 'AuntArctic')
 * @param {number} rawXpToAdd - Raw XP amount to add
 * @param {number} currentInternalXp - Current internal XP value
 * @returns {number} New internal XP value
 */
const UNIT = 1_000_000;
const DEFAULT_THRESHOLDS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];

export function addXpToInternal(mascot: string, rawXpToAdd: number, currentInternalXp: number): number {
    const thresholds: number[] = config.mascotXPThresholds[mascot] || DEFAULT_THRESHOLDS;
    let internal = currentInternalXp;
    let remaining = rawXpToAdd;

    for (let guard = 0; remaining > 0 && guard < 100; guard++) {
        const level = Math.floor(internal / UNIT);
        const current = thresholds[level] || 0;
        const next = thresholds[level + 1] || (current + 100);
        const range = next - current;

        if (range <= 0) {
            // Bad/duplicate threshold: skip the level unless it's really the last one
            if (level + 1 < thresholds.length - 1) {
                internal = (level + 1) * UNIT;
                continue;
            }
            return internal; // max level
        }

        const rawToNextLevel = (((level + 1) * UNIT - internal) * range) / UNIT;
        if (remaining >= rawToNextLevel) {
            internal = (level + 1) * UNIT;          // land exactly on the boundary
            remaining -= rawToNextLevel;
        } else {
            internal += Math.ceil((remaining * UNIT) / range);  // ceil, not floor
            remaining = 0;
        }
    }
    return internal;
}

/**
 * Get the current level from internal XP
 *
 * @param {number} internalXp - Internal XP value
 * @returns {number} Current level
 */
export function getLevelFromXp(internalXp: number): number {
    return Math.floor(internalXp / 1000000);
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
