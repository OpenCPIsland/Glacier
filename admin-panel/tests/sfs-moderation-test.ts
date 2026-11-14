// Game-server admin listener: who is online and where, kick, applying and
// clearing a mute at once, and warning notices. The rank rule comes from
// the live session; actorSwid (the actor's linked swid or null) is required.
import { resolve } from "node:path";
import { makeChecker } from "../../tools/lib/harness.ts";
import { startServers, Client, sleep } from "../../tools/lib/staff-client.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "e".repeat(64);
const PORT = 18592 + (process.pid % 300);
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };
const admin: Actor = { email: "admin@x.com", role: "admin", extras: [] };
const until = async (cond: () => boolean, ms = 2000) => { for (let t = 0; t < ms && !cond(); t += 20) await sleep(20); return cond(); };

const servers = await startServers({ sfsEnv: { BUN_OPTIONS: `--preload=${REPO}/smartfox-server/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, SFS_ADMIN_PORT: String(PORT) } });
const call = async (method: "GET" | "POST", path: string, body: any, actor: Actor, action: string, opts: { omitActor?: boolean } = {}) => {
  const raw = body === undefined ? "" : JSON.stringify(opts.omitActor || "actorSwid" in body ? body : { ...body, actorSwid: null });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "Content-Type": "application/json", ...signHeaders(SECRET, method, path, raw, actor, action) }, body: method === "POST" ? raw : undefined });
      return { status: res.status, json: await res.json().catch(() => null) as any };
    } catch { await sleep(100); }
  }
  throw new Error("game-server admin listener never came up");
};

try {
  const carol = new Client(servers, "{sm-carol}", "SmCarol");
  const dave = new Client(servers, "{sm-dave}", "SmDave");
  const mo = new Client(servers, "{sm-mod}", "SmMod");
  for (const c of [carol, dave, mo]) await c.account();
  await fetch(`${servers.api.base}/api/internal/set-role`, { method: "POST", headers: servers.api.internalHeaders(), body: JSON.stringify({ username: mo.username, role: "moderator" }) });
  for (const c of [carol, dave, mo]) await c.connect();

  check((await call("GET", "/online", undefined, mod, "dashboard.view")).status === 403, "/online signed for another action → 403");
  let r = await call("GET", "/online", undefined, mod, "players.view");
  const players = r.json?.players ?? [];
  const c = players.find((p: any) => p.swid === "{sm-carol}");
  check(r.status === 200 && players.length === 3, `three players online (${JSON.stringify(r.json)})`);
  check(c?.accountName === carol.username && c?.role === "player" && typeof c?.world === "string" && typeof c?.room === "string" && c.room.length > 0, `carol's entry (${JSON.stringify(c)})`);
  check(typeof c?.connectedAt === "number" && Date.now() - c.connectedAt < 60_000 && c?.mutedUntil === null, "connectedAt and mutedUntil");
  check(players.find((p: any) => p.swid === "{sm-mod}")?.role === "moderator", "roles come from the live session");

  // Mute applied live
  const untilIso = new Date(Date.now() + 10 * 60_000).toISOString();
  r = await call("POST", "/mute/apply", { swid: "{sm-carol}", until: untilIso }, mod, "player.mute");
  check(r.status === 200 && r.json?.applied === 1, `mute/apply → applied 1 (${JSON.stringify(r)})`);
  await until(() => carol.errors.some((e) => e.includes("muted")));
  check(carol.errors.some((e) => e.includes("You are muted for 10 minutes")), `the player is told (${carol.errors})`);
  for (const x of [carol, dave, mo]) x.reset();
  await carol.chat("can you hear me"); await sleep(300);
  check(!dave.roomChats.includes("can you hear me"), "a live mute stops chat at once");
  r = await call("GET", "/online", undefined, mod, "players.view");
  check(typeof r.json?.players?.find((p: any) => p.swid === "{sm-carol}")?.mutedUntil === "number", "/online shows mutedUntil");
  r = await call("POST", "/mute/clear", { swid: "{sm-carol}" }, mod, "player.unmute");
  check(r.status === 200 && r.json?.cleared === 1, "mute/clear");
  for (const x of [carol, dave, mo]) x.reset();
  await carol.chat("back"); await sleep(300);
  check(dave.roomChats.includes("back"), "chat works after the clear");
  for (const bad of [{ swid: "{sm-carol}", until: "soon" }, { swid: "{sm-carol}", until: new Date(Date.now() - 1000).toISOString() }, { swid: "nope", until: untilIso }]) {
    check((await call("POST", "/mute/apply", bad, mod, "player.mute")).status === 400, `mute/apply ${JSON.stringify(bad).slice(0, 50)} → 400`);
  }

  // A live mute set by an admin can't be replaced or cleared by a moderator;
  // mutes are capped at 7 days.
  r = await call("POST", "/mute/apply", { swid: "{sm-dave}", until: untilIso }, admin, "player.mute");
  check(r.status === 200 && r.json?.applied === 1, "an admin applies a mute");
  r = await call("POST", "/mute/apply", { swid: "{sm-dave}", until: new Date(Date.now() + 60_000).toISOString() }, mod, "player.mute");
  check(r.status === 403 && r.json?.error === "rank", `a moderator can't replace it (${JSON.stringify(r)})`);
  r = await call("POST", "/mute/clear", { swid: "{sm-dave}" }, mod, "player.unmute");
  check(r.status === 403 && r.json?.error === "rank", "or clear it");
  r = await call("POST", "/mute/clear", { swid: "{sm-dave}" }, admin, "player.unmute");
  check(r.status === 200 && r.json?.cleared === 1, "the admin clears it");
  r = await call("POST", "/mute/apply", { swid: "{sm-dave}", until: new Date(Date.now() + 7 * 86_400_000 + 120_000).toISOString() }, admin, "player.mute");
  check(r.status === 400, "a mute longer than 7 days → 400");

  // Notices
  r = await call("POST", "/notice", { swid: "{sm-dave}", key: "warned" }, mod, "player.warn");
  check(r.status === 200 && r.json?.sent === 1, "notice sent");
  await until(() => dave.bubbles.length + dave.errors.length > 0);
  check([...dave.bubbles, ...dave.errors].some((t) => t.includes("A moderator has warned you")), `the warning line (${dave.bubbles} ${dave.errors})`);
  check((await call("POST", "/notice", { swid: "{sm-dave}", key: "anything goes" }, mod, "player.warn")).status === 400, "an unknown notice key → 400");

  // Rank, self, contract
  r = await call("POST", "/kick", { swid: "{sm-mod}" }, mod, "player.kick");
  check(r.status === 403 && r.json?.error === "rank" && !mo.closed, `a moderator can't kick a moderator (${JSON.stringify(r)})`);
  r = await call("POST", "/mute/apply", { swid: "{sm-mod}", until: untilIso }, mod, "player.mute");
  check(r.status === 403 && r.json?.error === "rank", "or mute one live");
  r = await call("POST", "/kick", { swid: "{sm-mod}", actorSwid: "{SM-MOD}" }, admin, "player.kick");
  check(r.status === 403 && r.json?.error === "self", "nobody kicks their own linked account (case ignored)");
  r = await call("POST", "/kick", { swid: "{sm-carol}" }, mod, "player.kick", { omitActor: true });
  check(r.status === 400 && !carol.closed, "a body without actorSwid → 400");
  check((await call("POST", "/kick", { swid: "{sm-carol}" }, mod, "players.view")).status === 403, "a call signed for players.view can't kick");

  r = await call("POST", "/kick", { swid: "{sm-carol}" }, mod, "player.kick");
  check(r.status === 200 && r.json?.kicked === 1, "kick → kicked 1");
  await until(() => carol.closed);
  check(carol.kickReason === 1 && carol.closed, `the player gets reason 1 and is disconnected (${carol.kickReason})`);
  r = await call("POST", "/kick", { swid: "{sm-carol}" }, mod, "player.kick");
  check(r.status === 200 && r.json?.kicked === 0, "kicking someone offline → kicked 0");
  r = await call("POST", "/kick", { swid: "{sm-mod}" }, admin, "player.kick");
  check(r.status === 200 && r.json?.kicked === 1, "an admin kicks a moderator");
} finally {
  await servers.stop();
}
finish(servers.sfsLog());
