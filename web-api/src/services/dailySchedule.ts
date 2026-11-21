/**
 * Daily task schedule
 *
 * Today's list comes from data/daily-schedule.json, keyed by UTC month-day
 * "MM-DD" (01-01 .. 12-31, plus 02-29). The same 366 lists repeat every
 * year, switching at UTC midnight. Edit any date to change its tasks.
 */

import schedule from "../../data/daily-schedule.json" with { type: "json" };

const DAYS = schedule.days as Record<string, string[]>;
let warned = "";

export function dateKey(now = Date.now()): string {
    return new Date(now).toISOString().slice(5, 10);
}

/** The task ids on today's list. */
export function activeTaskIds(now = Date.now()): string[] {
    const key = dateKey(now);
    const ids = DAYS[key];
    if (!ids && warned !== key) {
        warned = key;
        console.warn(`[SCHEDULE] no daily tasks in daily-schedule.json for ${key}`);
    }
    return ids ?? [];
}