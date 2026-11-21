/**
 * Scheduled event windows
 *
 * ScheduledEventDates.json maps a DateDefinitionKey id to a start and end time
 * (epoch ms). ClaimableReward.json entries point at one through
 * DateDefinitionKey.Id, and a reward can only be claimed while its window is open.
 */

import config from "../config.ts";

/**
 * Whether the event with this DateDefinitionKey id is running at `now`.
 *
 * - An id missing from ScheduledEventDates.json is closed.
 * - A window whose end is not after its start (0/0 placeholders, or the
 *   start == end entry used for always-available rewards such as the welcome
 *   tee) has nothing to enforce and counts as open.
 * - Otherwise the window runs from start up to, not including, end.
 */
export function isEventActive(dateKeyId: number | undefined, now: number = Date.now()): boolean {
    if (dateKeyId === undefined) return false;
    const window = config.scheduledEventDates[dateKeyId];
    if (!window) return false;
    if (window.end <= window.start) return true;
    return now >= window.start && now < window.end;
}
