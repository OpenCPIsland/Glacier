// Kick, mute, warn, ban and lift flows end to end: listener effect, one
// audit row each, reasons, CSRF, rank/self/cap refusals, double taps, and a
// game server that is down.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { Client, sleep } from "../../tools/lib/staff-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const api = s.servers.api;
const store = openStore(s.dbPath, ["boss@x.com"]);
const SELF = "{ac-self}";
for (const [email, role, link] of [["mod@x.com", "moderator", null], ["mod2@x.com", "moderator", null], ["adm@x.com", "admin", null], ["self@x.com", "moderator", SELF]] as const)
  store.upsertStaff("boss@x.com", { email, role, extras: [], linkedSwid: link });

const P = { alice: "{ac-alice}", carol: "{ac-carol}", gina: "{ac-gina}", bob: "{ac-bob}", frank: "{ac-frank}", hank: "{ac-hank}", ivy: "{ac-ivy}", jo: "{ac-jo}", kim: "{ac-kim}", lee: "{ac-lee}", dave: "{ac-dave}", root: "{ac-root}", moe: "{ac-moe}" };
for (const [n, swid] of Object.entries(P)) await createPlayer(api.base, api.dbPath, swid, n[0]!.toUpperCase() + n.slice(1));
await createPlayer(api.base, api.dbPath, SELF, "Selfie");
const pu = (swid: string) => `/players/${encodeURIComponent(swid)}`;
const q = (sql: string, ...a: any[]) => { const d = new Database(api.dbPath, { readonly: true }); const r = d.query(sql).all(...a); d.close(); return r as any[]; };
const act = (kind: string, swid: string, email: string, fields: Record<string, string>, opts?: { csrf?: string | null }) => s.post(`${pu(swid)}/${kind}`, email, fields, opts);
const loc = (r: Response) => r.headers.get("location") ?? "";
const audits = (action: string, target: string) => queryAudit(store, { action, target, limit: 20 });
const R = "Spamming chat";
const setRole = async (swid: string, role: string) => { const username = q("SELECT username FROM player_identity WHERE swid = ?", swid)[0].username; await fetch(`${api.base}/api/internal/set-role`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ username, role }) }); };

try {
  const alice = new Client(s.servers, P.alice, "Alice"); await alice.connect();
  const carol = new Client(s.servers, P.carol, "Carol"); await carol.connect();
  const gina = new Client(s.servers, P.gina, "Gina"); await gina.connect();
  const selfC = new Client(s.servers, SELF, "Selfie"); await selfC.connect();

  // ---- forms (also the no-JS pages)
  let t = await (await s.get(`${pu(P.bob)}/ban`, "mod@x.com")).text();
  check(t.includes('name="reason"') && /name="_csrf" value="[0-9a-f]{64}"/.test(t) && t.includes('id="ladder"') && t.includes("Spamming chat") && t.includes("TROLL"), "ban form page: reason, CSRF, ladder data, reason templates, categories");
  check(!t.includes("Permanent") && !t.includes("permanent"), "a moderator's ban form offers no permanent option");
  t = await (await s.get(`${pu(P.bob)}/ban`, "adm@x.com")).text();
  check(t.includes("Permanent"), "an admin's ban form does");
  t = await (await s.get(`${pu(P.bob)}/kick`, "mod@x.com")).text();
  check(t.includes("Asked to be kicked"), "kick templates include kick-only ones");
  t = await (await s.get(`${pu(P.bob)}/mute`, "mod@x.com")).text();
  check(!t.includes("Asked to be kicked") && t.includes('name="minutes"'), "mute form: no kick-only template, has minutes");
  t = await (await s.get(`${pu(P.alice)}`, "mod@x.com")).text();
  check(t.includes('<dialog id="dlg-kick"') && t.includes('<dialog id="dlg-ban"'), "the player page embeds each action's form in a dialog");
  check((await s.get(`${pu(P.bob)}/ban`, "mod@x.com")).status === 200 && (await s.get(`${pu(P.bob)}/unmute`, "mod@x.com")).status === 200, "forms open for a player with nothing to lift (the action reports it)");
  check((await s.get(`${pu(P.bob)}/explode`, "mod@x.com")).status === 404, "unknown action page → 404");
  const js = await (await s.get("/static/app.js")).text();
  check(js.includes('addEventListener("submit"'), "app.js disables the submit button on submit");
  t = await (await s.get(`${pu(P.alice)}?done=banned`, "mod@x.com")).text();
  check(t.includes("Banned."), "?done= shows a fixed message");
  t = await (await s.get(`${pu(P.alice)}?done=%3Cscript%3E`, "mod@x.com")).text();
  check(!t.includes("<script>") && !t.includes('class="flash"'), "an unknown ?done= shows nothing");

  // ---- reasons, CSRF
  let r = await act("kick", P.alice, "mod@x.com", { reason: "" });
  check(r.status === 400 && !alice.closed, "kick without a reason → 400, nothing done");
  r = await act("kick", P.alice, "mod@x.com", { reason: "x".repeat(501) });
  check(r.status === 400 && !alice.closed, "reason over 500 characters → 400");
  r = await act("kick", P.alice, "mod@x.com", { reason: R }, { csrf: null });
  check(r.status === 403 && !alice.closed, "kick without CSRF → 403, nothing done");

  // ---- kick
  r = await act("kick", P.alice, "mod@x.com", { reason: R });
  await sleep(500);
  check(r.status === 303 && loc(r).endsWith("?done=kicked") && alice.closed, `kick: redirect with done=kicked, player disconnected (${r.status} ${loc(r)})`);
  let a = audits("player.kick", P.alice);
  check(a.length === 1 && a[0]!.result === "ok" && a[0]!.reason === R && a[0]!.actor === "mod@x.com", "kick: exactly one ok audit row with the reason");
  r = await act("kick", P.bob, "mod@x.com", { reason: R });
  check(loc(r).endsWith("?done=kicked-offline"), "kick of an offline player says so");

  // ---- mute / unmute
  r = await act("mute", P.carol, "mod@x.com", { reason: R, minutes: "0" });
  check(r.status === 400, "mute 0 minutes → 400");
  r = await act("mute", P.carol, "mod@x.com", { reason: R, minutes: "10081" });
  check(r.status === 400, "mute over 7 days → 400");
  check(q("SELECT * FROM moderation_mutes WHERE swid = ?", P.carol).length === 0, "refused mutes saved nothing");
  r = await act("mute", P.carol, "mod@x.com", { reason: R, minutes: "60" });
  check(r.status === 303 && loc(r).endsWith("?done=muted") && q("SELECT * FROM moderation_mutes WHERE swid = ? AND lifted_at IS NULL", P.carol).length === 1, "mute: saved and applied");
  a = audits("player.mute", P.carol);
  const okRows = a.filter((x) => x.result === "ok");
  check(okRows.length === 1 && JSON.stringify(okRows[0]!.params).includes('"minutes":60') && a.filter((x) => x.result === "failed").length === 2, "mute: one ok audit row with minutes; the two refused tries are audited as failed");
  carol.errors = []; await carol.chat("hello"); await sleep(400);
  check(carol.errors.some((e) => e.includes("muted")), `the muted player's chat is refused in game (${carol.errors})`);
  r = await act("unmute", P.carol, "mod@x.com", { reason: R });
  check(loc(r).endsWith("?done=unmuted") && q("SELECT lifted_at FROM moderation_mutes WHERE swid = ?", P.carol)[0].lifted_at, "unmute: lifted");
  check(audits("player.unmute", P.carol).length === 1, "unmute audited once");

  // ---- warn
  r = await act("warn", P.carol, "mod@x.com", { reason: R, type: "TROLL", level: "1" });
  check(r.status === 303 && loc(r).endsWith("?done=warned") && q("SELECT * FROM mix_sanctions WHERE swid = ?", P.carol).length === 1, "warn: sanction saved");
  r = await act("warn", P.carol, "mod@x.com", { reason: R, type: "TROLL", level: "3" });
  check(r.status === 409 && (await r.text()).includes("ban") && q("SELECT * FROM mix_sanctions WHERE swid = ?", P.carol).length === 1, "warn at a level that bans → refused, nothing saved");

  await s.restartPanel(); // resets the per-user change rate limit
  // ---- ban (ladder)
  r = await act("ban", P.bob, "mod@x.com", { reason: R, mode: "ladder", type: "TROLL", level: "2" });
  check(r.status === 303 && loc(r).endsWith("?done=banned"), `ladder ban TROLL 2 → done=banned (${r.status})`);
  const ban = q("SELECT * FROM mix_bans WHERE swid = ? AND lifted_at IS NULL", P.bob);
  check(ban.length === 1 && ban[0].set_by === "panel:mod@x.com" && ban[0].until, "ban saved as a 12 h ban set by the panel user");
  r = await act("ban", P.bob, "mod@x.com", { reason: R, mode: "ladder", type: "TROLL", level: "2" });
  const dup = await r.text();
  check(r.status === 409 && dup.toLowerCase().includes("already done") && q("SELECT * FROM mix_bans WHERE swid = ?", P.bob).length === 1, "a double tap: second answers 'already done', one ban row");
  check(audits("player.ban", P.bob).filter((x) => x.result === "ok").length === 1, "and exactly one ok audit row");
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "ladder", type: "TROLL", level: "1" });
  check(r.status === 409 && q("SELECT * FROM mix_bans WHERE swid = ?", P.frank).length === 0, "ban at a warning level → refused (use Warn)");
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "ladder", type: "NOPE", level: "2" });
  check(r.status === 400, "unknown category → 400");
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "ladder", type: "POTENTIAL_PAEDOPHILE", level: "1" });
  check(r.status === 400 && q("SELECT * FROM mix_bans WHERE swid = ?", P.frank).length === 0, "level below the category's minimum → refused, not clamped");

  await s.restartPanel(); // resets the per-user change rate limit
  // ---- ban (custom, caps, permanent)
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "custom", hours: "100" });
  check(r.status === 403 && q("SELECT * FROM mix_bans WHERE swid = ?", P.frank).length === 0, "a moderator's 100 h custom ban is refused");
  check(audits("player.ban", P.frank).some((x) => x.result === "denied"), "…and audited as denied");
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "custom", hours: "permanent" });
  check(r.status === 403 && q("SELECT * FROM mix_bans WHERE swid = ?", P.frank).length === 0, "a moderator can't choose permanent");
  check(audits("player.ban.permanent", P.frank).some((x) => x.result === "denied"), "…audited as player.ban.permanent denied");
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "ladder", type: "TROLL", level: "5" });
  check(r.status === 403 && q("SELECT * FROM mix_bans WHERE swid = ?", P.frank).length === 0, "a ladder level that is permanent is refused for a moderator");
  r = await act("ban", P.frank, "mod@x.com", { reason: R, mode: "custom", hours: "72" });
  check(r.status === 303 && q("SELECT * FROM mix_bans WHERE swid = ? AND until IS NOT NULL", P.frank).length === 1, "72 h is fine for a moderator");
  r = await act("ban", P.hank, "adm@x.com", { reason: R, mode: "custom", hours: "permanent" });
  check(r.status === 303 && q("SELECT * FROM mix_bans WHERE swid = ? AND until IS NULL", P.hank).length === 1 && audits("player.ban.permanent", P.hank)[0]?.result === "ok", "an admin bans permanently (audited as player.ban.permanent)");
  r = await act("ban", P.ivy, "adm@x.com", { reason: R, mode: "custom", hours: "0" });
  check(r.status === 400, "custom hours must be 1..8760 or permanent");
  r = await act("ban", P.ivy, "adm@x.com", { reason: R, mode: "custom", hours: "99999" });
  check(r.status === 400, "custom hours over a year → 400");

  // ---- ban kicks the player who is online
  r = await act("ban", P.gina, "mod@x.com", { reason: R, mode: "custom", hours: "1" });
  await sleep(500);
  check(loc(r).endsWith("?done=banned") && gina.closed, `banning an online player kicks them (${r.status} ${loc(r)} closed=${gina.closed})`);

  await s.restartPanel(); // resets the per-user change rate limit
  // ---- unban
  r = await act("unban", P.bob, "mod2@x.com", { reason: R });
  check(r.status === 403 && q("SELECT * FROM mix_bans WHERE swid = ? AND lifted_at IS NULL", P.bob).length === 1, "a moderator can't lift another moderator's ban");
  check(audits("player.unban", P.bob).some((x) => x.result === "denied" || x.result === "failed"), "…and it is audited");
  r = await act("unban", P.bob, "mod@x.com", { reason: R });
  check(loc(r).endsWith("?done=unbanned") && q("SELECT * FROM mix_bans WHERE swid = ? AND lifted_at IS NULL", P.bob).length === 0, "the setter lifts their own ban (" + r.status + " " + loc(r) + ")");
  r = await act("unban", P.hank, "adm@x.com", { reason: R });
  check(loc(r).endsWith("?done=unbanned"), "an admin lifts any");

  // ---- rank and self
  await setRole(P.root, "admin");
  r = await act("ban", P.root, "mod@x.com", { reason: R, mode: "custom", hours: "1" });
  check(r.status === 403 && q("SELECT * FROM mix_bans WHERE swid = ?", P.root).length === 0, "a moderator can't ban an in-game admin (" + r.status + " " + loc(r) + ")");
  check(audits("player.ban", P.root).some((x) => x.result === "denied"), "…audited as denied");
  r = await act("kick", SELF, "self@x.com", { reason: R });
  await sleep(300);
  check(r.status === 403 && !selfC.closed, "staff can't act on their own linked account");

  // ---- unknown player
  r = await act("kick", "{nobody-here}", "mod@x.com", { reason: R });
  check(r.status === 404, "unknown player → 404 (" + r.status + " " + loc(r) + ")");

  await s.restartPanel(); // resets the per-user change rate limit
  // ---- game server down
  await s.servers.stopSfs();
  r = await act("mute", P.dave, "mod@x.com", { reason: R, minutes: "30" });
  check(r.status === 303 && loc(r).endsWith("?done=muted-pending") && q("SELECT * FROM moderation_mutes WHERE swid = ?", P.dave).length === 1, "mute with the game server down: saved, 'muted-pending'");
  check(audits("player.mute", P.dave)[0]?.result === "partial", "…audited partial");
  r = await act("ban", P.jo, "mod@x.com", { reason: R, mode: "custom", hours: "1" });
  check(loc(r).endsWith("?done=banned-pending") && q("SELECT * FROM mix_bans WHERE swid = ?", P.jo).length === 1 && audits("player.ban", P.jo)[0]?.result === "partial", "ban with the game server down: saved, 'banned-pending', partial");
  r = await act("kick", P.kim, "mod@x.com", { reason: R });
  check(r.status === 502 && audits("player.kick", P.kim)[0]?.result === "failed", "kick with the game server down → says so, audited failed");
  r = await act("unmute", P.dave, "mod@x.com", { reason: R });
  check(loc(r).endsWith("?done=unmuted-pending") && audits("player.unmute", P.dave)[0]?.result === "partial", "unmute with the game server down: lifted, pending, partial");

  // ---- web API down
  await api.stop();
  r = await act("mute", P.lee, "mod@x.com", { reason: R, minutes: "30" });
  check(r.status === 502 && (await r.text()).includes("web API"), "web API down → 502, says nothing was changed (" + r.status + " " + loc(r) + ")");
  check(audits("player.mute", P.lee)[0]?.result === "failed", "…audited failed");
} finally {
  await s.stop();
}
finish();
process.exit(0);
