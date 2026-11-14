// web-api admin listener: player search, profile, history and stats
// (players.view / dashboard.view). Player text comes back as stored;
// escaping it is the panel's job.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "d".repeat(64);
const PORT = 18491 + (process.pid % 300);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(PORT) };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };

const api = await startWebApi({ env });
const admin = async (method: "GET" | "POST", path: string, body: unknown, action: string, actor = mod) => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = { "Content-Type": "application/json", ...signHeaders(SECRET, method, path, raw, actor, action) };
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: method === "POST" ? raw : undefined });
      return { status: res.status, json: await res.json().catch(() => null) as any };
    } catch { await Bun.sleep(100); }
  }
  throw new Error("admin listener never came up");
};
const sql = (q: string, ...args: any[]) => { const d = new Database(api.dbPath); d.query(q).run(...args); d.close(); };

try {
  const HOSTILE = "<b>x</b>‮evil";
  await createPlayer(api.base, api.dbPath, "{wp-carol}", "WpCarol");
  await createPlayer(api.base, api.dbPath, "{wp-carl}", "WpCarl");
  await createPlayer(api.base, api.dbPath, "{wp-evil}", HOSTILE);
  for (let i = 0; i < 25; i++) await createPlayer(api.base, api.dbPath, `{wp-bulk${i}}`, `WpBulk${i}`);

  check((await admin("POST", "/player/search", { q: "WpCar" }, "dashboard.view")).status === 403, "search signed for another action → 403");
  let r = await admin("POST", "/player/search", { q: "{wp-carol}" }, "players.view");
  check(r.status === 200 && r.json?.players?.length === 1 && r.json.players[0].displayName === "WpCarol", `search by swid is exact (${JSON.stringify(r.json)})`);
  r = await admin("POST", "/player/search", { q: "wpcar" }, "players.view");
  check(r.json?.players?.map((p: any) => p.displayName).sort().join() === "WpCarl,WpCarol", `search by name prefix ignores case (${JSON.stringify(r.json)})`);
  r = await admin("POST", "/player/search", { q: "WpBulk" }, "players.view");
  check(r.json?.players?.length === 20, `search is capped at 20 (${r.json?.players?.length})`);
  r = await admin("POST", "/player/search", { q: "%" }, "players.view");
  check(r.status === 200 && r.json?.players?.length === 0, "LIKE wildcards in the query are literal");
  for (const q of ["", "x".repeat(65), 5, null]) {
    check((await admin("POST", "/player/search", { q }, "players.view")).status === 400, `search with ${JSON.stringify(q)?.slice(0, 20)} → 400`);
  }
  r = await admin("POST", "/player/search", { q: "<b>" }, "players.view");
  check(r.json?.players?.[0]?.displayName === HOSTILE, "a hostile display name comes back unchanged");

  // Profile + history after a few moderation events.
  sql("INSERT INTO mix_sanctions (swid, type, level, moderator, reason) VALUES ('{wp-carol}', 'TROLL', 1, 'panel:a@x', 'rude')");
  sql("INSERT INTO mix_bans (swid, kind, until, set_by, reason) VALUES ('{wp-carol}', 'ban', ?, 'panel:a@x', 'spam')", new Date(Date.now() + 3_600_000).toISOString());
  sql("INSERT INTO moderation_mutes (swid, until, set_by, set_by_rank, reason) VALUES ('{wp-carol}', ?, 'game:Boss', 'admin', 'loud')", new Date(Date.now() + 600_000).toISOString());
  sql("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source) VALUES ('{wp-carl}', '{wp-carol}', 'ChatSwearing', 'cpi')");
  sql("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source, status) VALUES ('{wp-carl}', '{wp-carol}', 'Spamming', 'mix', 'dismissed')");
  sql("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source) VALUES ('{wp-carol}', '{wp-carl}', 'Mean', 'cpi')");

  r = await admin("POST", "/player/profile", { swid: "{wp-carol}" }, "players.view");
  const p = r.json;
  check(r.status === 200 && p?.swid === "{wp-carol}" && p?.displayName === "WpCarol" && typeof p?.username === "string" && p?.role === "player", `profile identity (${JSON.stringify(p)})`);
  check(typeof p?.createdAt === "string", "profile has createdAt");
  check(p?.ban?.reason === "spam" && p?.mute?.reason === "loud", "profile has the active ban and mute");
  check(p?.counts?.reportsOpen === 1 && p?.counts?.reportsTotal === 2 && p?.counts?.sanctions === 1, `profile counts (${JSON.stringify(p?.counts)})`);
  check((await admin("POST", "/player/profile", { swid: "{nobody}" }, "players.view")).status === 404, "unknown swid → 404");
  check((await admin("POST", "/player/profile", { swid: "nobraces" }, "players.view")).status === 400, "a malformed swid → 400");

  r = await admin("POST", "/player/history", { swid: "{wp-carol}" }, "players.view");
  const h = r.json;
  check(h?.sanctions?.length === 1 && h.sanctions[0].reason === "rude", "history: sanctions");
  check(h?.bans?.length === 1 && h.bans[0].set_by === "panel:a@x", "history: bans with who");
  check(h?.mutes?.length === 1 && h.mutes[0].set_by === "game:Boss", "history: mutes with who");
  check(h?.reportsAgainst?.length === 2 && h.reportsAgainst[0].reason === "Spamming", `history: reports against, newest first (${JSON.stringify(h?.reportsAgainst)})`);
  check(h?.reportsBy?.length === 1 && h.reportsBy[0].reason === "Mean", "history: reports by");

  r = await admin("GET", "/stats", undefined, "dashboard.view");
  check(r.status === 200 && r.json?.openReports === 2 && r.json?.activeMutes === 1 && r.json?.activeBans === 1, `stats (${JSON.stringify(r.json)})`);
} finally {
  await api.stop();
}
finish(api.logs());
