// services/moderation.ts storage for the admin panel: saved mutes, ladder
// outcomes, custom bans, reasons and who set or lifted what. Runs the
// service in-process against a temporary database that starts with the
// moderation tables in their older shape, so the migration is covered too.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const dbPath = join(mkdtempSync(join(tmpdir(), "modstore-")), "cpi_data.db");
{
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE mix_sanctions (id INTEGER PRIMARY KEY AUTOINCREMENT, swid TEXT NOT NULL, type TEXT NOT NULL,
      level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5), alert_id INTEGER, moderator TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE mix_bans (swid TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('ban', 'lock')), until TEXT NULL,
      sanction_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, lifted_at TEXT NULL);
    CREATE TABLE mix_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_swid TEXT NOT NULL, reported_swid TEXT NOT NULL, reason TEXT,
      thread_id INTEGER NULL, message_id INTEGER NULL, source TEXT NOT NULL CHECK (source IN ('mix', 'cpi')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO mix_bans (swid, kind, until) VALUES ('{old}', 'ban', NULL);
  `);
  old.close();
}
process.env.ICEBERG_DB_PATH = dbPath;
const m = await import("../web-api/src/services/moderation.ts");
const raw = new Database(dbPath);
const cols = (t: string) => (raw.query(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);

check(["set_by", "reason", "lifted_by"].every((c) => cols("mix_bans").includes(c)), `old mix_bans gains set_by, reason, lifted_by (${cols("mix_bans")})`);
check(cols("mix_sanctions").includes("reason"), "old mix_sanctions gains reason");
check(["resolved_by", "resolved_at", "resolution"].every((c) => cols("mix_reports").includes(c)), "old mix_reports gains resolved_by, resolved_at, resolution");
check(cols("moderation_mutes").length > 0, "moderation_mutes exists");
check(m.isBanned("{old}") !== null, "a ban from before the migration still holds");

// Mutes
const first = m.setMute("{a}", 10, "panel:mod@x.com", "moderator", "Spamming chat") as Exclude<ReturnType<typeof m.setMute>, "rank">;
check(first.swid === "{a}" && first.set_by === "panel:mod@x.com" && first.set_by_rank === "moderator" && first.reason === "Spamming chat", "setMute stores who, rank and reason");
const untilMs = Date.parse(first.until);
check(Math.abs(untilMs - (Date.now() + 10 * 60_000)) < 5000 && first.until.endsWith("Z"), `until is ISO UTC, 10 minutes ahead (${first.until})`);
m.setMute("{a}", 30, "game:Boss", "admin", null);
const active = raw.query("SELECT * FROM moderation_mutes WHERE swid = '{a}' AND lifted_at IS NULL").all();
check(active.length === 1, `a new mute replaces the active one (${active.length} active)`);
check(m.activeMute("{a}")?.set_by === "game:Boss", "activeMute is the newest");
raw.query("INSERT INTO moderation_mutes (swid, until, set_by, set_by_rank) VALUES ('{expired}', ?, 'x', 'moderator')").run(new Date(Date.now() - 1000).toISOString());
check(m.activeMute("{expired}") === null, "an expired mute isn't active");
const state = m.activeMutes(["{a}", "{b}", "{expired}"]);
check(Object.keys(state).join() === "{a}" && typeof state["{a}"] === "string", `activeMutes lists only muted swids (${JSON.stringify(state)})`);
check(m.setMute("{a}", 1, "panel:mod@x.com", "moderator", "shorter") === "rank", "a moderator can't replace an admin-rank mute (that would lift it)");
check(m.activeMute("{a}")?.set_by === "game:Boss", "the refused replace leaves the admin's mute");
check(m.liftMute("{a}", "panel:mod@x.com", "moderator") === "rank", "a moderator can't lift an admin-rank mute");
check(m.activeMute("{a}") !== null, "a refused lift leaves the mute");
check(m.liftMute("{a}", "panel:admin@x.com", "admin") === "lifted", "an admin can");
check(m.activeMute("{a}") === null, "lifted");
check((raw.query("SELECT lifted_by FROM moderation_mutes WHERE swid = '{a}' ORDER BY id DESC LIMIT 1").get() as any).lifted_by === "panel:admin@x.com", "lifted_by is stored");
check(m.liftMute("{a}", "panel:admin@x.com", "admin") === "none", "lifting nothing says none");

// Ladder outcomes
check(m.ladderOutcome("POTENTIAL_PAEDOPHILE", 1).valid === false, "a level below the type's minimum is invalid");
check(m.ladderOutcome("TROLL", 0).valid === false && m.ladderOutcome("TROLL", 6).valid === false && m.ladderOutcome("TROLL", 2.5).valid === false, "levels outside 1..5 or not whole are invalid");
const troll2 = m.ladderOutcome("TROLL", 2);
check(troll2.valid && troll2.rung?.kind === "ban" && troll2.rung.hours === 12, `TROLL 2 is a 12 h ban (${JSON.stringify(troll2)})`);
check(m.ladderOutcome("TROLL", 1).rung === null, "TROLL 1 is a warning");
check(m.ladderOutcome("TROLL", 5).rung?.hours === null, "TROLL 5 is open-ended");

// Sanctions with reasons
const s = m.sanction("{b}", "TROLL", 2, "panel:mod@x.com", "Rude to new players");
check((raw.query("SELECT reason FROM mix_sanctions ORDER BY id DESC LIMIT 1").get() as any).reason === "Rude to new players", "sanction stores the reason");
check(s.ban?.set_by === "panel:mod@x.com" && s.ban?.reason === "Rude to new players", "the ladder's ban row has set_by and reason");
m.sanction("{c}", "TROLL", 1, "cli");
check((raw.query("SELECT reason FROM mix_sanctions ORDER BY id DESC LIMIT 1").get() as any).reason === null, "the reason is optional (tools/mod.ts)");

// Custom bans and lifting
const custom = m.banFor("{d}", 24, "panel:admin@x.com", "Exploiting a bug");
check(custom.kind === "ban" && custom.set_by === "panel:admin@x.com" && custom.reason === "Exploiting a bug" && custom.sanction_id === null, "banFor makes a plain ban with who and why");
check(Math.abs(Date.parse(custom.until!) - (Date.now() + 24 * 3_600_000)) < 5000, "24 hours");
const forever = m.banFor("{e}", null, "panel:admin@x.com", "x");
check(forever.until === null && m.isBanned("{e}") !== null, "banFor with null hours is open-ended");
check(m.activeBans("{d}").length === 1 && m.activeBans("{nobody}").length === 0, "activeBans");
check(m.liftBan("{d}", "panel:owner@x.com") === true && m.isBanned("{d}") === null, "liftBan lifts");
check((raw.query("SELECT lifted_by FROM mix_bans WHERE swid = '{d}'").get() as any).lifted_by === "panel:owner@x.com", "liftBan stores who");
check(m.liftBan("{e}") === true, "liftBan without who still works (tools/mod.ts)");

finish();
