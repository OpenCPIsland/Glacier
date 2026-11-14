// web-api admin listener: chat log reads and the retention setting
// (chat.view / chat.retention). Chat text comes back as stored; escaping it
// is the panel's job.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "e".repeat(64);
const PORT = 18791 + (process.pid % 300);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(PORT) };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };
const owner: Actor = { email: "boss@x.com", role: "owner", extras: [] };

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
const db = () => new Database(api.dbPath);
const ins = (swid: string, room: string | null, text: string, at: string, status = "sent") => {
  const d = db();
  d.query("INSERT INTO chat_log (swid, username, room, world, original, shown, status, created_at) VALUES (?, 'u', ?, 'Blizzard', ?, ?, ?, ?)").run(swid, room, text, text, status, at);
  d.close();
};
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

try {
  // by-player: 150 rows for A, one for B
  for (let i = 0; i < 150; i++) ins("{cl-a}", "Town", `a${i}`, at(i));
  ins("{cl-b}", "Town", "from b", at(5));

  let r = await admin("POST", "/chat/by-player", { swid: "{cl-a}" }, "chat.view");
  check(r.status === 200 && r.json?.rows?.length === 100 && r.json.rows[0].original === "a149" && r.json.rows[99].original === "a50", `first page: 100 rows newest first (${r.json?.rows?.length})`);
  check(r.json?.rows?.every((x: any) => x.swid === "{cl-a}") && typeof r.json?.next === "number", "only that player's rows, with a cursor");
  r = await admin("POST", "/chat/by-player", { swid: "{cl-a}", before: r.json.next }, "chat.view");
  check(r.json?.rows?.length === 50 && r.json.rows[0].original === "a49" && r.json.next === null, `second page: 50 rows, no cursor (${r.json?.rows?.length}, ${r.json?.next})`);
  check(typeof r.json?.rows?.[0]?.createdAt === "string" && "room" in r.json.rows[0] && "status" in r.json.rows[0], "rows carry createdAt, room, status");
  r = await admin("POST", "/chat/by-player", { swid: "{nobody}" }, "chat.view");
  check(r.status === 200 && r.json?.rows?.length === 0 && r.json?.next === null, "unknown player: empty page");
  check((await admin("POST", "/chat/by-player", { swid: "nobraces" }, "chat.view")).status === 400, "malformed swid → 400");
  check((await admin("POST", "/chat/by-player", { swid: "{cl-a}", before: "5" }, "chat.view")).status === 400, "non-integer cursor → 400");
  check((await admin("POST", "/chat/by-player", { swid: "{cl-a}" }, "players.view")).status === 403, "signed for another action → 403");

  // search
  ins("{cl-c}", "Dock", "100%_sure", at(200)); ins("{cl-c}", "Dock", "100 sure", at(201)); ins("{cl-c}", null, "no room here", at(202)); ins("{cl-c}", "Dock", "back\\slash", at(203));
  const win = (a: number, b: number) => ({ from: at(a), to: at(b) });
  r = await admin("POST", "/chat/search", { room: "Dock", ...win(190, 300) }, "chat.view");
  check(r.status === 200 && r.json?.rows?.length === 3 && r.json.rows.every((x: any) => x.room === "Dock"), `room filter (${r.json?.rows?.length})`);
  r = await admin("POST", "/chat/search", { ...win(200, 202) }, "chat.view");
  check(r.json?.rows?.length === 2, `window: from inclusive, to exclusive (${r.json?.rows?.length})`);
  r = await admin("POST", "/chat/search", { ...win(190, 300), q: "0%_" }, "chat.view");
  check(r.json?.rows?.length === 1 && r.json.rows[0].original === "100%_sure", `q with % and _ is literal (${JSON.stringify(r.json?.rows?.map((x: any) => x.original))})`);
  r = await admin("POST", "/chat/search", { ...win(190, 300), q: "\\" }, "chat.view");
  check(r.json?.rows?.length === 1 && r.json.rows[0].original === "back\\slash", "q with a backslash is literal");
  r = await admin("POST", "/chat/search", { ...win(190, 300), q: "NO ROOM" }, "chat.view");
  check(r.json?.rows?.length === 1 && r.json.rows[0].room === null, "q is case-insensitive; NULL room rows come back");
  r = await admin("POST", "/chat/search", { from: at(0), to: new Date(T0 + 24 * 3600_000).toISOString() }, "chat.view");
  check(r.status === 200, "a 24 h window is allowed");
  r = await admin("POST", "/chat/search", { from: at(0), to: new Date(T0 + 24 * 3600_000 + 60_000).toISOString() }, "chat.view");
  check(r.status === 400, "a window over 24 h → 400");
  for (const [label, body] of [
    ["to <= from", { from: at(10), to: at(10) }], ["unparsable from", { from: "yesterday", to: at(10) }], ["missing to", { from: at(1) }],
    ["empty q", { ...win(1, 2), q: "" }], ["65-char q", { ...win(1, 2), q: "x".repeat(65) }], ["numeric room", { ...win(1, 2), room: 5 }], ["empty room", { ...win(1, 2), room: "" }],
  ] as const) check((await admin("POST", "/chat/search", body, "chat.view")).status === 400, `search with ${label} → 400`);
  for (let i = 0; i < 120; i++) ins("{cl-d}", "Plaza", `p${i}`, at(400 + i));
  r = await admin("POST", "/chat/search", { room: "Plaza", ...win(399, 600) }, "chat.view");
  const next = r.json?.next;
  const r2 = await admin("POST", "/chat/search", { room: "Plaza", ...win(399, 600), before: next }, "chat.view");
  check(r.json?.rows?.length === 100 && r2.json?.rows?.length === 20 && r2.json?.next === null, "search pages the same way (100, then 20)");

  // retention
  r = await admin("POST", "/chat/retention/get", {}, "chat.view");
  check(r.status === 200 && r.json?.days === 30, `retention default 30 (${JSON.stringify(r.json)})`);
  ins("{cl-old}", "Town", "ancient", "2026-01-01T00:00:00.000Z");
  check((await admin("POST", "/chat/by-player", { swid: "{cl-old}" }, "chat.view")).json?.rows?.length === 1, "an old row exists before retention is shortened");
  r = await admin("POST", "/chat/retention/set", { days: 14 }, "chat.retention", owner);
  check(r.status === 200 && r.json?.days === 14, "owner sets retention");
  check((await admin("POST", "/chat/by-player", { swid: "{cl-old}" }, "chat.view")).json?.rows?.length === 0, "shortening retention deletes rows past the new window at once");
  check((await admin("POST", "/chat/by-player", { swid: "{cl-a}" }, "chat.view")).json?.rows?.length === 100, "rows inside the window stay");
  r = await admin("POST", "/chat/retention/get", {}, "chat.view");
  check(r.json?.days === 14, "the new value is read back");
  for (const days of [0, 366, "7", 30.5, null, -3]) {
    check((await admin("POST", "/chat/retention/set", { days }, "chat.retention", owner)).status === 400, `retention ${JSON.stringify(days)} → 400`);
  }
  check((await admin("POST", "/chat/retention/get", {}, "chat.view")).json?.days === 14, "bad values left the setting alone");
  check((await admin("POST", "/chat/retention/set", { days: 7 }, "players.view", owner)).status === 403, "retention set signed for another action → 403");
  const row = db().query("SELECT value FROM settings WHERE key = 'chat_log_retention_days'").get() as { value: string };
  check(row?.value === "14", "stored in the settings table");
} finally {
  await api.stop();
}
finish();
