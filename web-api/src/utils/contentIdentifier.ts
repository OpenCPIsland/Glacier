// Content identifier of a room name: clientVersion;contentVersion;date;abTestGroup.
// The date is the content date the client reads. The game's schedule is 332 days
// (2018-03-06 .. 2019-01-31) and plays on a loop, so today maps to the schedule
// day at (UTC days since 2018-03-06) % 332 (same rule as dailySchedule.ts).
import config from "../config.ts";

const DAY_MS = 86400000;
const LOOP_START_DAY = Math.floor(Date.UTC(2018, 2, 6) / DAY_MS);
const LOOP_LENGTH = 332;

export function todayUtc(now = new Date()): string {
    return now.toISOString().slice(0, 10);
}

/** The schedule day today plays, as "YYYY-MM-DD" in 2018-03-06 .. 2019-01-31. */
export function contentDate(now = new Date()): string {
    const day = Math.floor(now.getTime() / DAY_MS);
    const offset = (((day - LOOP_START_DAY) % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;
    return new Date((LOOP_START_DAY + offset) * DAY_MS).toISOString().slice(0, 10);
}

export function buildContentIdentifier(clientVersion = config.content.clientVersion, now = new Date()): string {
    const { contentVersion, abTestGroup } = config.content;
    return `1;${contentVersion};${contentDate(now)};${abTestGroup}`;

}
