// Chat log (admin panel 2b): POST /chat/v1/message/verify records every
// room-chat message in chat_log; the retention setting and the purge live
// in services/chatLog.ts.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();

const api = await startWebApi({
  env: { ALLOW_SWID_AUTH: "1" },
  beforeStart: (dbPath) => {
    // Creating the table here keeps the starter filter list from seeding.
    const d = new Database(dbPath);
    d.exec(`CREATE TABLE IF NOT EXISTS mix_moderation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, kind TEXT NOT NULL,
      action TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    const ins = d.prepare("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES (?, ?, ?)");
    ins.run("darn", "word", "mask");
    ins.run("heck", "word", "block");
    d.close();
  },
});

const verify = async (swid: string, message: string, senderSessionId: unknown = 1) => {
  const res = await fetch(`${api.base}/chat/v1/message/verify`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json" },
    body: JSON.stringify({ senderSessionId, message, emotion: 0, moderated: false }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const rows = (q: string, ...a: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...a) as any[]; } finally { d.close(); } };
const run = (q: string, ...a: any[]) => { const d = new Database(api.dbPath); try { d.query(q).run(...a); } finally { d.close(); } };

try {
  await createPlayer(api.base, api.dbPath, "{CL-1}", "ChatAlice");
  await createPlayer(api.base, api.dbPath, "{CL-2}", "ChatNoSession");
  run(`INSERT INTO player_sessions (session_id, swid, username, room_name, world) SELECT 4242, swid, username, 'Town', 'Blizzard' FROM player_identity WHERE swid = ?`, "{CL-1}");

  let r = await verify("{CL-1}", "hello there", 4242);
  check(r.status === 200, `clean message verifies (${r.status})`);
  r = await verify("{CL-1}", "darn it", 4242);
  check(r.status === 200 && r.body?.data?.moderated === true, "masked message still verifies");
  r = await verify("{CL-1}", "what the heck", 4242);
  check(r.status === 200 && r.body?.data?.moderated === true, "blocked message still verifies");

  let log = rows("SELECT * FROM chat_log WHERE swid = ? ORDER BY id", "{CL-1}");
  check(log.length === 3, `three rows logged (${log.length})`);
  check(log.map((x) => x.status).join() === "sent,masked,blocked", `statuses ${log.map((x) => x.status)}`);
  check(log[1]?.original === "darn it" && log[1]?.shown === "**** it", `masked keeps the original (${log[1]?.original} / ${log[1]?.shown})`);
  check(log[2]?.original === "what the heck" && !/heck/i.test(log[2]?.shown ?? "heck"), "blocked keeps the original, shown is masked");
  check(log[0]?.room === "Town" && log[0]?.world === "Blizzard", `room/world from the session (${log[0]?.room}/${log[0]?.world})`);
  check(log[0]?.username === "PenguinCL1" || typeof log[0]?.username === "string" && log[0].username.length > 0, "username stored");
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(log[0]?.created_at ?? ""), `created_at is ISO UTC (${log[0]?.created_at})`);

  // No session row: logged with NULL room. A session id that belongs to someone else falls back to the player's newest session.
  r = await verify("{CL-2}", "anyone here", 999);
  const noSess = rows("SELECT * FROM chat_log WHERE swid = ?", "{CL-2}");
  check(r.status === 200 && noSess.length === 1 && noSess[0].room === null && noSess[0].world === null, "no session row: room is NULL");
  r = await verify("{CL-1}", "wrong session id", 999);
  const fb = rows("SELECT room FROM chat_log WHERE swid = ? ORDER BY id DESC LIMIT 1", "{CL-1}");
  check(fb[0]?.room === "Town", `unknown session id falls back to the player's newest session (${fb[0]?.room})`);

  // Active mute
  run(`INSERT INTO moderation_mutes (swid, until, set_by, set_by_rank, reason) VALUES (?, ?, 'mod', 'moderator', 'test')`, "{CL-1}", new Date(Date.now() + 3600_000).toISOString());
  r = await verify("{CL-1}", "muted words", 4242);
  const muted = rows("SELECT status, original FROM chat_log WHERE swid = ? ORDER BY id DESC LIMIT 1", "{CL-1}");
  check(r.status === 200 && muted[0]?.status === "muted" && muted[0]?.original === "muted words", "muted sender is logged as muted, verify behaviour unchanged");

  // Empty text is not logged; one account can't fill the disk.
  const emptyBefore = rows("SELECT COUNT(*) AS n FROM chat_log")[0].n;
  r = await verify("{CL-1}", "", 4242);
  check(r.status === 200 && rows("SELECT COUNT(*) AS n FROM chat_log")[0].n === emptyBefore, "an empty message is not logged");
  await createPlayer(api.base, api.dbPath, "{CL-3}", "ChatFlood");
  // Over the cap the server must refuse to sign, so every message that can be
  // relayed has a log row (a signed-but-unlogged message would evade moderation).
  const signed: string[] = [];
  let refused = 0, signedOverCap = 0;
  for (let i = 0; i < 90; i++) {
    const v = await verify("{CL-3}", `flood ${i}`);
    if (v.status === 200 && typeof v.body?.signature === "string") signed.push(`flood ${i}`);
    else if (v.status === 429) refused++;
    if (i >= 60 && v.status === 200) signedOverCap++;
  }
  const floodRows = rows("SELECT original FROM chat_log WHERE swid = ?", "{CL-3}").map((x) => x.original);
  check(signed.length === 60 && refused === 30 && signedOverCap === 0, `60 signed, 30 refused with 429 (${signed.length} signed, ${refused} refused)`);
  check(floodRows.length === 60 && signed.every((m) => floodRows.includes(m)), `every signed message has a log row (${floodRows.length} rows)`);
  r = await verify("{CL-1}", "someone else can still chat", 4242);
  check(rows("SELECT COUNT(*) AS n FROM chat_log WHERE swid = ? AND original = ?", "{CL-1}", "someone else can still chat")[0].n === 1, "the cap is per account");

  // Logging failure never breaks chat
  run("DROP TABLE chat_log");
  r = await verify("{CL-1}", "after the table is gone", 4242);
  check(r.status === 200 && r.body?.data?.message === "after the table is gone" && typeof r.body?.signature === "string", `verify survives a failed insert (${r.status})`);
  check(!api.logs().split("\n").some((l) => l.includes("[CHAT-LOG]") && l.includes("after the table is gone")), "the failure log line does not contain the chat text");
  check(api.logs().includes("[CHAT-LOG]"), "the failure is logged");
} finally {
  await api.stop();
}

// Retention and purge, run in-process against a scratch database.
const scratch = join(mkdtempSync(join(tmpdir(), "chatlog-")), "scratch.db");
process.env.ICEBERG_DB_PATH = scratch;
const svc = await import("../web-api/src/services/chatLog.ts");
const sdb = new Database(scratch);
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const add = (daysAgo: number, text: string) => sdb.query(`INSERT INTO chat_log (swid, username, room, world, original, shown, status, created_at) VALUES ('{P}', 'p', 'Town', 'W', ?, ?, 'sent', ?)`).run(text, text, iso(daysAgo));

check(svc.getRetentionDays() === 30, "retention defaults to 30 days");
svc.setRetentionDays(7);
check(svc.getRetentionDays() === 7, "setRetentionDays persists");
for (const bad of [0, 366, 30.5, -1, NaN, "7" as any]) {
  let threw = false;
  try { svc.setRetentionDays(bad); } catch (e) { threw = e instanceof RangeError; }
  check(threw && svc.getRetentionDays() === 7, `setRetentionDays(${String(bad)}) throws RangeError and leaves 7`);
}
add(8, "old"); add(6, "recent");
check(svc.purgeChatLog() === 1, "purge removes the row older than 7 days");
const left = sdb.query("SELECT original FROM chat_log").all().map((x: any) => x.original);
check(left.join() === "recent", `only the recent row is left (${left})`);
for (let i = 0; i < 1500; i++) add(9, `bulk${i}`);
check(svc.purgeChatLog() === 1500, "purge clears more than one batch");
sdb.close();

finish();
