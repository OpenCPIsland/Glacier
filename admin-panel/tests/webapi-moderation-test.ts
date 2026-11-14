// web-api admin listener: mute, warn, ban (timed / permanent) and lifting,
// with the rank rule, the self rule, the moderator 72 h cap, the ladder
// route split, duplicate protection and the ban lift rule. These are the
// checks that hold even if the panel itself is bypassed.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "d".repeat(64);
const PORT = 18791 + (process.pid % 300);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(PORT) };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };
const mod2: Actor = { email: "mod2@x.com", role: "moderator", extras: [] };
const admin: Actor = { email: "admin@x.com", role: "admin", extras: [] };
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };

const api = await startWebApi({ env });
// The panel always says which game account the actor is linked to (null
// when none); a body without actorSwid is refused, so the self rule fails closed.
const call = async (actor: Actor, action: string, path: string, body: any, opts: { omitActor?: boolean } = {}) => {
  const raw = JSON.stringify(opts.omitActor || "actorSwid" in body ? body : { ...body, actorSwid: null });
  const headers = { "Content-Type": "application/json", ...signHeaders(SECRET, "POST", path, raw, actor, action) };
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers, body: raw });
      return { status: res.status, json: await res.json().catch(() => null) as any };
    } catch { await Bun.sleep(100); }
  }
  throw new Error("admin listener never came up");
};
const q = (sql: string, ...a: any[]) => { const d = new Database(api.dbPath, { readonly: true }); const r = d.query(sql).all(...a); d.close(); return r as any[]; };
const setRole = (swid: string, role: string) => {
  const username = q("SELECT username FROM player_identity WHERE swid = ?", swid)[0].username;
  return fetch(`${api.base}/api/internal/set-role`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ username, role }) });
};
const R = "Spamming chat";

try {
  for (const [swid, name] of [["{wm-p1}", "WmP1"], ["{wm-p2}", "WmP2"], ["{wm-p3}", "WmP3"], ["{wm-p4}", "WmP4"], ["{wm-p5}", "WmP5"], ["{wm-mod}", "WmMod"], ["{wm-adm}", "WmAdm"]]) {
    await createPlayer(api.base, api.dbPath, swid, name);
  }
  await setRole("{wm-mod}", "moderator");
  await setRole("{wm-adm}", "admin");

  // Mute
  let r = await call(mod, "player.mute", "/mute", { swid: "{wm-p1}", minutes: 60, reason: R });
  check(r.status === 200 && typeof r.json?.until === "string", `moderator mutes a player (${JSON.stringify(r)})`);
  const row = q("SELECT * FROM moderation_mutes WHERE swid = '{wm-p1}'")[0];
  check(row?.set_by === "panel:mod@x.com" && row?.set_by_rank === "moderator" && row?.reason === R, `mute row has who, rank, reason (${JSON.stringify(row)})`);
  for (const minutes of [0, 10081, 2.5, "60"]) {
    check((await call(mod, "player.mute", "/mute", { swid: "{wm-p1}", minutes, reason: R })).status === 400, `mute minutes ${JSON.stringify(minutes)} → 400`);
  }
  check((await call(mod, "player.mute", "/mute", { swid: "{wm-p1}", minutes: 5, reason: " " })).status === 400, "a blank reason → 400");
  check((await call(mod, "player.mute", "/mute", { swid: "{wm-p1}", minutes: 5, reason: "r".repeat(501) })).status === 400, "a 501-char reason → 400");
  check((await call(mod, "player.mute", "/mute", { swid: "{nobody}", minutes: 5, reason: R })).status === 404, "unknown player → 404");
  r = await call(mod, "player.mute", "/mute", { swid: "{wm-mod}", minutes: 5, reason: R });
  check(r.status === 403 && r.json?.error === "rank", `a moderator can't mute a moderator (${JSON.stringify(r)})`);
  r = await call(admin, "player.mute", "/mute", { swid: "{wm-mod}", minutes: 5, reason: R });
  check(r.status === 200, "an admin can mute a moderator");
  check((await call(admin, "player.mute", "/mute", { swid: "{wm-adm}", minutes: 5, reason: R })).json?.error === "rank", "an admin can't mute an admin");
  check((await call(owner, "player.mute", "/mute", { swid: "{wm-adm}", minutes: 5, reason: R })).status === 200, "the owner can mute an in-game admin");
  r = await call(owner, "player.mute", "/mute", { swid: "{wm-adm}", minutes: 5, reason: R, actorSwid: "{wm-adm}" });
  check(r.status === 403 && r.json?.error === "self", `nobody acts on their own linked account (${JSON.stringify(r)})`);
  check((await call(mod, "player.kick", "/mute", { swid: "{wm-p1}", minutes: 5, reason: R })).status === 403, "a call signed for player.kick can't use /mute");
  r = await call(owner, "player.mute", "/mute", { swid: "{wm-p1}", minutes: 5, reason: R }, { omitActor: true });
  check(r.status === 400, `a body without actorSwid is refused (${r.status})`);
  r = await call(owner, "player.mute", "/mute", { swid: "{wm-adm}", minutes: 5, reason: R, actorSwid: "{WM-ADM}" });
  check(r.status === 403 && r.json?.error === "self", "the self rule ignores case");
  check((await call(owner, "player.mute", "/mute", { swid: "{wm-p1}", minutes: 5, reason: R, actorSwid: 5 })).status === 400, "a malformed actorSwid → 400");

  r = await call(admin, "player.mute", "/mute", { swid: "{wm-p2}", minutes: 600, reason: R });
  r = await call(mod, "player.mute", "/mute", { swid: "{wm-p2}", minutes: 1, reason: R });
  check(r.status === 403 && r.json?.error === "rank", "a moderator can't replace an admin's mute");
  r = await call(mod, "player.unmute", "/mute/lift", { swid: "{wm-p2}", reason: R });
  check(r.status === 403 && r.json?.error === "rank", "or lift it");
  r = await call(admin, "player.unmute", "/mute/lift", { swid: "{wm-p2}", reason: R });
  check(r.status === 200 && r.json?.lifted === true, "an admin lifts it");
  check(q("SELECT lifted_by FROM moderation_mutes WHERE swid = '{wm-p2}'")[0].lifted_by === "panel:admin@x.com", "lifted_by recorded");

  // Warn
  r = await call(mod, "player.warn", "/warn", { swid: "{wm-p3}", type: "TROLL", level: 1, reason: R });
  check(r.status === 200 && typeof r.json?.alertId === "number" && r.json?.level === 1, `warn TROLL 1 (${JSON.stringify(r)})`);
  check(q("SELECT reason FROM mix_sanctions WHERE swid = '{wm-p3}'")[0]?.reason === R, "the warning stores the reason");
  r = await call(mod, "player.warn", "/warn", { swid: "{wm-p3}", type: "TROLL", level: 2, reason: R });
  check(r.status === 409 && r.json?.error === "use /ban", `a ban rung via /warn → 409 use /ban (${JSON.stringify(r)})`);
  r = await call(mod, "player.warn", "/warn", { swid: "{wm-p3}", type: "TROLL", level: 5, reason: R });
  check(r.status === 409 && r.json?.error === "use /ban/permanent", "an open-ended rung via /warn → 409 use /ban/permanent");
  check((await call(mod, "player.warn", "/warn", { swid: "{wm-p3}", type: "POTENTIAL_PAEDOPHILE", level: 1, reason: R })).status === 400, "a level below the type's minimum → 400 (not clamped)");
  check((await call(mod, "player.warn", "/warn", { swid: "{wm-p3}", type: "toString", level: 1, reason: R })).status === 400, "an unknown type → 400");

  // Timed bans
  r = await call(mod, "player.ban", "/ban", { mode: "ladder", swid: "{wm-p3}", type: "TROLL", level: 2, reason: R });
  check(r.status === 200 && r.json?.ban?.kind === "ban" && r.json.ban.set_by === "panel:mod@x.com", `ladder TROLL 2 via /ban (${JSON.stringify(r)})`);
  check(Math.abs(Date.parse(r.json?.ban?.until) - (Date.now() + 12 * 3_600_000)) < 10_000, "12 hours");
  r = await call(mod, "player.ban", "/ban", { mode: "custom", swid: "{wm-p3}", hours: 24, reason: R });
  check(r.status === 409 && r.json?.error === "duplicate", `a second ban within 10 s → 409 duplicate (${JSON.stringify(r)})`);
  check(q("SELECT COUNT(*) AS n FROM mix_bans WHERE swid = '{wm-p3}'")[0].n === 1, "only one ban row");
  r = await call(mod, "player.ban", "/ban", { mode: "ladder", swid: "{wm-p4}", type: "TROLL", level: 1, reason: R });
  check(r.status === 409 && r.json?.error === "use /warn", "a warning rung via /ban → 409 use /warn");
  r = await call(mod, "player.ban", "/ban", { mode: "ladder", swid: "{wm-p4}", type: "TROLL", level: 5, reason: R });
  check(r.status === 409 && r.json?.error === "use /ban/permanent", "an open-ended rung via /ban → 409");
  r = await call(mod, "player.ban", "/ban", { mode: "custom", swid: "{wm-p4}", hours: 100, reason: R });
  check(r.status === 403 && r.json?.error === "cap", `a moderator's 100 h ban → 403 cap (${JSON.stringify(r)})`);
  r = await call(mod, "player.ban", "/ban", { mode: "custom", swid: "{wm-p4}", hours: null, reason: R });
  check(r.status === 409 && r.json?.error === "use /ban/permanent", "a custom open-ended ban via /ban → 409");
  for (const hours of [0, 8761, 1.5, "24"]) {
    check((await call(admin, "player.ban", "/ban", { mode: "custom", swid: "{wm-p4}", hours, reason: R })).status === 400, `custom hours ${JSON.stringify(hours)} → 400`);
  }
  check((await call(admin, "player.ban", "/ban", { mode: "other", swid: "{wm-p4}", hours: 1, reason: R })).status === 400, "unknown mode → 400");
  r = await call(admin, "player.ban", "/ban", { mode: "custom", swid: "{wm-p4}", hours: 100, reason: R });
  check(r.status === 200 && r.json?.ban?.reason === R && r.json.ban.sanction_id === null, "an admin's 100 h custom ban");
  check((await call(mod, "player.ban", "/ban", { mode: "custom", swid: "{wm-mod}", hours: 1, reason: R })).json?.error === "rank", "a moderator can't ban a moderator");

  // Permanent
  r = await call(mod, "player.ban.permanent", "/ban/permanent", { mode: "custom", swid: "{wm-p5}", hours: null, reason: R });
  check(r.status === 403, `a moderator can't sign /ban/permanent (${r.status})`);
  r = await call(admin, "player.ban.permanent", "/ban/permanent", { mode: "custom", swid: "{wm-p5}", hours: 24, reason: R });
  check(r.status === 409 && r.json?.error === "use /ban", "a timed ban via /ban/permanent → 409 use /ban");
  r = await call(admin, "player.ban.permanent", "/ban/permanent", { mode: "ladder", swid: "{wm-p5}", type: "TROLL", level: 5, reason: R });
  check(r.status === 200 && r.json?.ban?.until === null, `admin: TROLL 5 is open-ended (${JSON.stringify(r)})`);

  // Lifting
  r = await call(mod2, "player.unban", "/ban/lift", { swid: "{wm-p4}", reason: R });
  check(r.status === 403 && r.json?.error === "not yours", `a moderator can't lift an admin's ban (${JSON.stringify(r)})`);
  r = await call(mod2, "player.unban", "/ban/lift", { swid: "{wm-p3}", reason: R });
  check(r.status === 403 && r.json?.error === "not yours", "or another moderator's");
  r = await call(mod, "player.unban", "/ban/lift", { swid: "{wm-p3}", reason: R });
  check(r.status === 200 && r.json?.lifted === true, "a moderator lifts their own ban");
  check(q("SELECT lifted_by FROM mix_bans WHERE swid = '{wm-p3}'")[0].lifted_by === "panel:mod@x.com", "lifted_by recorded");
  r = await call({ ...mod2, extras: ["ban.lift.any"] }, "player.unban", "/ban/lift", { swid: "{wm-p4}", reason: R });
  check(r.status === 200 && r.json?.lifted === true, "the ban.lift.any extra lets a moderator lift any ban");
  r = await call(admin, "player.unban", "/ban/lift", { swid: "{wm-p5}", reason: R });
  check(r.status === 200 && r.json?.lifted === true, "an admin lifts any ban");
  r = await call(admin, "player.unban", "/ban/lift", { swid: "{wm-p5}", reason: R });
  check(r.status === 200 && r.json?.lifted === false, "nothing to lift → lifted false");

  // The ladder as data for the panel's ban form.
  r = await call(mod, "players.view", "/ladder", {});
  const trollRungs = r.json?.types?.find((t: any) => t.type === "TROLL");
  check(r.status === 200 && r.json.types.length === 11 && trollRungs?.min === 1 && trollRungs.rungs.map((x: any) => x.outcome).join() === "warn,ban,ban,ban,permanent" && trollRungs.rungs[1].hours === 12, `/ladder lists the 11 types with outcomes (${JSON.stringify(trollRungs)})`);
  check(r.json.types.find((t: any) => t.type === "POTENTIAL_PAEDOPHILE").min === 3, "a type's minimum level is given");
  check(r.json.types.find((t: any) => t.type === "VULNERABLE_PERSON").rungs[2].outcome === "lock", "locks are their own outcome");
  r = await call(mod, "players.view", "/ladder", { swid: "{wm-p1}" });
  check(typeof r.json?.suggested?.TROLL === "number" && r.json.suggested.TROLL >= 1, "with a swid, a suggested level per type is added");
  r = await call(mod, "player.kick", "/ladder", {});
  check(r.status === 403, "/ladder is signed for players.view only");
} finally {
  await api.stop();
}
finish(api.logs());
