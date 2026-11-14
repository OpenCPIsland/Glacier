// Chat mutes are saved in the web API (moderation_mutes) and cached by the
// game server: they survive a game-server restart, follow the periodic
// recheck (a mute set or lifted elsewhere, e.g. by the admin panel,
// reaches online players), and :mute still works for the session when the
// web API can't save it.
import { Database } from "bun:sqlite";
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep } from "./lib/staff-client.ts";

const { check, finish } = makeChecker();
const until = async (cond: () => boolean, ms = 3000) => { for (let t = 0; t < ms && !cond(); t += 20) await sleep(20); return cond(); };

const servers = await startServers({ sfsEnv: { SFS_BAN_RECHECK_MS: "500" } });
const mod = new Client(servers, "{mp-mod}", "MpMod");
const carol = new Client(servers, "{mp-carol}", "MpCarol");
const dave = new Client(servers, "{mp-dave}", "MpDave");
const boss = new Client(servers, "{mp-boss}", "MpBoss");
const everyone = [mod, carol, dave, boss];
for (const c of everyone) await c.account();
for (const [c, role] of [[mod, "moderator"], [boss, "admin"]] as const) {
  await fetch(`${servers.api.base}/api/internal/set-role`, {
    method: "POST", headers: servers.api.internalHeaders(), body: JSON.stringify({ username: c.username, role }),
  });
}
const SAY = async (c: Client, text: string, wait = 300) => { for (const x of everyone) x.reset(); await c.chat(text); await sleep(wait); };
const db = () => new Database(servers.api.dbPath);
const activeRows = (swid: string) => {
  const d = db();
  const rows = d.query("SELECT * FROM moderation_mutes WHERE swid = ? AND lifted_at IS NULL AND until > ?").all(swid, new Date().toISOString()) as any[];
  d.close();
  return rows;
};
const connectAll = async () => { for (const c of everyone) await c.connect(); };
const heard = async (speaker: Client, text: string) => { await SAY(speaker, text); return dave.roomChats.includes(text) || mod.roomChats.includes(text); };

try {
  await connectAll();
  await SAY(mod, `:mute ${carol.username} 30`);
  const rows = activeRows("{mp-carol}");
  check(rows.length === 1 && rows[0].set_by === `game:${mod.username}` && rows[0].set_by_rank === "moderator", `:mute saves a row (${JSON.stringify(rows)})`);
  check(!(await heard(carol, "muted one")), "the muted player isn't heard");

  for (const c of everyone) if (c.sock && !c.closed) c.disconnect();
  await servers.restartSfs();
  await connectAll();
  check(!(await heard(carol, "after restart")), "the mute survives a game-server restart");
  check(carol.errors.some((e) => e.includes("muted")), `and the player is told (${carol.errors})`);

  // Lifted elsewhere (the admin panel): the recheck lets them talk again.
  { const d = db(); d.query("UPDATE moderation_mutes SET lifted_at = ?, lifted_by = 'test' WHERE swid = '{mp-carol}'").run(new Date().toISOString()); d.close(); }
  await sleep(1200);
  check(await heard(carol, "free again"), "a mute lifted in the database is dropped at the next recheck");

  // Set elsewhere: reaches an online player at the next recheck.
  { const d = db(); d.query("INSERT INTO moderation_mutes (swid, until, set_by, set_by_rank) VALUES ('{mp-dave}', ?, 'panel:x@y.z', 'admin')").run(new Date(Date.now() + 600_000).toISOString()); d.close(); }
  await sleep(1200);
  for (const x of everyone) x.reset();
  await dave.chat("dave speaks"); await sleep(300);
  check(!mod.roomChats.includes("dave speaks") && !carol.roomChats.includes("dave speaks"), "a mute added in the database reaches an online player at the next recheck");

  // A moderator can't lift (or shorten) an admin-rank mute from the game.
  await SAY(mod, `:unmute ${dave.username}`);
  check(mod.errors.some((e) => e.includes("was muted by an admin")), `:unmute of an admin's mute is refused (${mod.errors})`);
  await SAY(mod, `:mute ${dave.username} 1`);
  check(mod.errors.some((e) => e.includes("was muted by an admin")), `:mute over an admin's mute is refused (${mod.errors})`);
  check(activeRows("{mp-dave}")[0]?.set_by === "panel:x@y.z", "the admin's mute is unchanged");

  // The web API can't save it (here: a trigger refuses the insert, since
  // chat itself needs the web API): the mute still applies for this
  // session, and says so.
  { const d = db(); d.exec("CREATE TRIGGER no_mutes BEFORE INSERT ON moderation_mutes BEGIN SELECT RAISE(ABORT, 'test: refused'); END"); d.close(); }
  await SAY(mod, `:mute ${carol.username} 5`);
  check(mod.bubbles.some((b) => b.includes(`Muted ${carol.username}`) && b.includes("until the next restart only")), `unsaved mute says so (${mod.bubbles})`);
  check(!(await heard(carol, "unsaved mute")), "and still mutes");

  // Unsaved mutes keep the rank rule and survive reconnecting.
  await SAY(mod, `:unmute ${carol.username}`);
  await SAY(boss, `:mute ${carol.username} 60`);
  check(boss.bubbles.some((b) => b.includes("until the next restart only")), "an admin's unsaved mute");
  await SAY(mod, `:unmute ${carol.username}`);
  check(mod.errors.some((e) => e.includes("was muted by an admin")), `a moderator can't lift an admin's unsaved mute (${mod.errors})`);
  await SAY(mod, `:mute ${carol.username} 1`);
  check(mod.errors.some((e) => e.includes("was muted by an admin")), `a moderator can't replace an admin's unsaved mute (${mod.errors})`);
  carol.disconnect(); await sleep(150); await carol.connect();
  check(!(await heard(carol, "reconnected")), "an unsaved mute survives reconnecting");
} finally {
  await servers.stop().catch(() => {});
}
finish();
