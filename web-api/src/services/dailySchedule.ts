// The daily challenge schedule: which tasks are today's, the same for every
// player. "days" holds two kinds of key:
//   - "MM-DD" (all 366): a list for that month-day, repeating every year.
//     This is the 2026 schedule.
//   - "YYYY-MM-DD": a list for that exact date, which wins over the MM-DD
//     one. data/daily-schedule.json has every date of 2027.
// It's stored in the settings table and edited in the admin panel; with no
// row (or an unreadable one) the default in data/daily-schedule.json is used
// (tools/gen-daily-schedule.ts builds it from the client's dated schedules).
//
// Only today's listed tasks count and pay (routes/task.ts), and the list
// goes to the client in joinRoomData (routes/game.ts). A day is normally
// Disney's 6 entries: 4 tasks, ClothingCatalogSubmission and
// TaskCompletion_5. Other shapes are allowed and only warned about, so
// custom days stay possible.
import { currentTaskDay, getSetting, setSetting } from "../database.ts";
import seed from "../../data/daily-schedule.json" with { type: "json" };
import dailyTaskData from "../../../smartfox-server/data/daily-tasks.json" with { type: "json" };

export const DAILY_SCHEDULE_KEY = "daily_schedule";
export interface DailySchedule { version: 1; days: Record<string, string[]> }
export interface ScheduleWarning { key: string; warning: string }

interface TaskDef { group: number; reward: { mascotXP?: Record<string, number> } }
const TASKS = dailyTaskData.tasks as Record<string, TaskDef>;
const CANONICAL = new Map(Object.keys(TASKS).map((id) => [id.toLowerCase(), id]));
const DAY_SIZE = 6;
const REQUIRED = ["ClothingCatalogSubmission", "TaskCompletion_5"];
const KEY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** "MM-DD" of a task day (whole UTC days since the epoch). */
export function monthDayKey(day: number): string {
  return new Date(day * 86400000).toISOString().slice(5, 10);
}

/** "YYYY-MM-DD" of a task day. */
export function dateKey(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function isDateKey(key: string): boolean {
  return DATE_KEY.test(key) && dateKey(Date.parse(`${key}T00:00:00Z`) / 86400000) === key;
}

function isMonthDay(key: string): boolean {
  if (!KEY.test(key)) return false;
  const [m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(2024, m! - 1, d!)).getUTCMonth() === m! - 1; // 2024 is a leap year
}

function isSchedule(v: unknown): v is DailySchedule {
  if (!v || typeof v !== "object") return false;
  const days = (v as DailySchedule).days;
  return !!days && typeof days === "object"
    && Object.entries(days).every(([k, ids]) => (isMonthDay(k) || isDateKey(k)) && Array.isArray(ids) && ids.every((id) => typeof id === "string"));
}

export function getDailySchedule(): DailySchedule {
  const raw = getSetting(DAILY_SCHEDULE_KEY);
  if (raw !== null) {
    try {
      const v = JSON.parse(raw);
      if (isSchedule(v)) return v;
    } catch { /* fall through */ }
    console.log(`[DAILIES] the stored schedule is unreadable; using the default`);
  }
  return seed as DailySchedule;
}

const loggedUnknown = new Set<string>();

/** Today's (or the given day's) task ids, in order: canonical case, unknown ids dropped, no repeats. */
export function activeTaskIds(day: number = currentTaskDay()): string[] {
  const days = getDailySchedule().days;
  const key = days[dateKey(day)] ? dateKey(day) : monthDayKey(day);
  const out: string[] = [];
  for (const raw of days[key] ?? []) {
    const id = CANONICAL.get(raw.trim().toLowerCase());
    if (!id) {
      if (!loggedUnknown.has(`${key}/${raw}`)) {
        loggedUnknown.add(`${key}/${raw}`);
        console.log(`[DAILIES] ${key} lists unknown task "${raw}"; skipped`);
      }
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Replaces one day's list ("MM-DD" or "YYYY-MM-DD"; ids as given, trimmed). Throws only for a bad key or a non-string id. */
export function setDailyDay(key: string, ids: string[]): DailySchedule {
  if (typeof key !== "string" || !(isMonthDay(key) || isDateKey(key))) throw new Error(`bad day "${key}"`);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error("ids must be strings");
  const current = getDailySchedule();
  const next: DailySchedule = { version: 1, days: { ...current.days, [key]: ids.map((id) => id.trim()) } };
  setSetting(DAILY_SCHEDULE_KEY, JSON.stringify(next));
  return next;
}

/** Shape problems for the panel to show. None of them stop a save. */
export function validateDailySchedule(s: DailySchedule): ScheduleWarning[] {
  const out: ScheduleWarning[] = [];
  const keys = [
    ...Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(5, 10)),
    ...Object.keys(s.days).filter(isDateKey).sort(),
  ];
  for (const key of keys) {
    const ids = s.days[key];
    if (!ids) { out.push({ key, warning: "no tasks" }); continue; }
    const add = (warning: string) => out.push({ key, warning });
    if (ids.length !== DAY_SIZE) add(`has ${ids.length} tasks, expected ${DAY_SIZE}`);
    const seen = new Set<string>();
    for (const raw of ids) {
      const id = CANONICAL.get(raw.trim().toLowerCase());
      if (!id) { add(`unknown task ${raw}`); continue; }
      if (seen.has(id)) add(`${id} listed twice`);
      seen.add(id);
    }
    for (const r of REQUIRED) if (!seen.has(r)) add(`missing ${r}`);
  }
  return out;
}

/** Every task the server knows, for the panel's pickers. */
export function taskPool(): { id: string; group: number; mascot: string | null }[] {
  return Object.entries(TASKS)
    .map(([id, def]) => {
      const m = Object.keys(def.reward.mascotXP ?? {});
      return { id, group: def.group, mascot: m.length === 1 ? m[0]! : null };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
