// Chat viewer (admin panel 2b): the player Chat tab, the room/time search
// page and the owner's retention form. Every view is audited, and a view
// whose audit row can't be written is refused. Chat text is attacker
// controlled, so it must come out escaped everywhere.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const api = s.servers.api;
const store = openStore(s.dbPath, ["boss@x.com"]);
for (const [email, role] of [["mod@x.com", "moderator"], ["adm@x.com", "admin"], ["gone@x.com", "moderator"]] as const)
  store.upsertStaff("boss@x.com", { email, role, extras: [], linkedSwid: null });
store.setDisabled("boss@x.com", "gone@x.com", true);

const ALICE = "{cp-alice}", BOB = "{cp-bob}", BULK = "{cp-bulk}";
const pu = (swid: string) => `/players/${encodeURIComponent(swid)}`;
for (const [swid, name] of [[ALICE, "CpAlice"], [BOB, "CpBob"], [BULK, "CpBulk"]] as const) await createPlayer(api.base, api.dbPath, swid, name);
const text = async (path: string, email = "mod@x.com") => { const r = await s.get(path, email); return { r, t: await r.text() }; };
const seed = (swid: string, room: string | null, original: string, shown: string, status: string, at: string) => {
  const d = new Database(api.dbPath);
  d.query("INSERT INTO chat_log (swid, username, room, world, original, shown, status, created_at) VALUES (?, 'someone', ?, 'Blizzard', ?, ?, ?, ?)").run(swid, room, original, shown, status, at);
  d.close();
};
const audits = (action = "chat.view") => queryAudit(store, { action, limit: 100 });
const HOSTILE = `<script>alert(1)</script> "q" 'x' ‮evil`;
const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const local = (minAgo: number) => iso(minAgo).slice(0, 16);

try {
  seed(ALICE, "Town", "hello MARKER1", "hello MARKER1", "sent", iso(30));
  seed(ALICE, "Town", "darn it MARKER2", "**** it MARKER2", "masked", iso(20));
  seed(ALICE, null, "heck MARKER3", "**** MARKER3", "blocked", iso(10));
  seed(ALICE, "Town", HOSTILE, HOSTILE, "sent", iso(5));
  seed(BOB, "Dock", "bob in the dock MARKER4", "bob in the dock MARKER4", "muted", iso(15));

  // Player tab
  const before = audits().length;
  let { r, t } = await text(`${pu(ALICE)}?tab=chat`);
  check(r.status === 200 && t.includes("MARKER1") && t.includes("MARKER2") && !t.includes("MARKER4"), "the Chat tab lists that player's messages only");
  check(!t.includes("Chat (2b)") && t.includes(`href="${pu(ALICE)}?tab=chat"`), "the Chat tab is a real tab now");
  check(!t.includes("<script>alert(1)</script>") && t.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "hostile chat text is escaped on the tab");
  check(t.includes("unknown room"), "a row with no room says unknown room");
  check(/Masked/.test(t) && /Blocked/.test(t) && t.includes("darn it MARKER2"), "masked and blocked rows are labelled and show what was typed");
  check(/not (necessarily )?(delivered|relayed|reach)|may not have reached/i.test(t), "the page says logged messages may not have been delivered");
  const a = audits();
  check(a.length === before + 1 && a[0]!.actor === "mod@x.com" && a[0]!.target === `player:${ALICE}` && (a[0]!.params as any).rows === 4 && a[0]!.result === "ok", `one audit row for the view (${JSON.stringify(a[0])})`);

  // Search page
  ({ r, t } = await text("/chat"));
  check(r.status === 200 && t.includes('name="from"') && t.includes('name="to"') && t.includes('name="room"') && t.includes('name="q"'), "/chat shows the search form");
  check(audits().length === before + 1, "opening the empty search form is not a chat view (no audit row)");
  // The default window must include "now": `to` is exclusive, so it has to be after the current minute.
  const defTo = t.match(/name="to" value="([^"]+)"/)?.[1] ?? "";
  check(Date.parse(defTo + ":00Z") > Date.now(), `the default To is after now, so a message from seconds ago is found (${defTo})`);
  const q = (o: Record<string, string>) => "/chat?" + new URLSearchParams(o).toString();
  ({ r, t } = await text(q({ from: local(60), to: local(0), room: "Dock" })));
  check(r.status === 200 && t.includes("MARKER4") && !t.includes("MARKER1") && /Muted/.test(t), "search by room");
  const sa = audits()[0]!;
  check(audits().length === before + 2 && sa.target === "room:Dock" && (sa.params as any).rows === 1 && typeof (sa.params as any).from === "string" && typeof (sa.params as any).to === "string", `search audit row records room, window, rows (${JSON.stringify(sa)})`);
  ({ r, t } = await text(q({ from: local(60), to: local(0), q: "marker2" })));
  check(t.includes("MARKER2") && !t.includes("MARKER1"), "search by text, case-insensitive");
  check(!t.includes("<script>alert(1)</script>"), "no raw script tag on the search page");
  ({ r, t } = await text(q({ from: local(60), to: local(0) })));
  check(t.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && t.includes("&quot;q&quot;"), "hostile text escaped on the search page, quotes included");
  const tooWide = await text(q({ from: local(60 * 30), to: local(0) }));
  check(tooWide.r.status === 200 && /24 hours/.test(tooWide.t), "a window over 24 h shows the web API's refusal");
  const n = audits().length;
  await text(q({ from: "nonsense", to: local(0) }));
  check(audits().length === n, "a refused query writes no chat.view row");

  // Audit failure refuses the view and leaks nothing
  const adb = new Database(s.dbPath);
  adb.exec("CREATE TRIGGER no_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit down'); END");
  ({ r, t } = await text(`${pu(ALICE)}?tab=chat`));
  check(r.status === 500 && !t.includes("MARKER1") && !t.includes("&lt;script&gt;"), `audit failure: 500 and no chat text (${r.status})`);
  ({ r, t } = await text(q({ from: local(60), to: local(0) })));
  check(r.status === 500 && !t.includes("MARKER1"), `audit failure on the search page too (${r.status})`);
  adb.exec("DROP TRIGGER no_audit");
  adb.close();
  check((await text(`${pu(ALICE)}?tab=chat`)).r.status === 200, "views work again once audit writes do");

  // Paging
  for (let i = 0; i < 101; i++) seed(BULK, "Plaza", `bulk${i}`, `bulk${i}`, "sent", new Date(NOW - 100_000 + i).toISOString());
  ({ r, t } = await text(`${pu(BULK)}?tab=chat`));
  const older = t.match(/href="([^"]*tab=chat&amp;before=\d+)"/)?.[1];
  check(r.status === 200 && t.includes("bulk100") && !t.includes(">bulk0<") && !!older, "101 rows: first page has an Older link");
  ({ t } = await text(older!.replace(/&amp;/g, "&")));
  check(t.includes("bulk0") && !t.includes("bulk100"), "the Older link shows the rest");
  check(audits()[0]!.params && (audits()[0]!.params as any).rows === 1, "the second page audits its own row count");

  // Access
  check((await s.get("/chat", "gone@x.com")).status === 403 && (await s.get(`${pu(ALICE)}?tab=chat`, "gone@x.com")).status === 403, "a disabled staff member gets 403");
  check((await s.get("/chat", null)).status === 403, "no Access token → 403");
  ({ t } = await text("/more", "mod@x.com"));
  check(t.includes('href="/chat"'), "More lists Chat search");

  // Retention
  ({ t } = await text("/chat", "mod@x.com"));
  check(t.includes("30 days") && !t.includes('action="/chat/retention"'), "moderator sees the retention, no form");
  check((await s.post("/chat/retention", "mod@x.com", { days: "7", reason: "x" })).status === 403, "moderator can't set retention");
  check((await s.post("/chat/retention", "adm@x.com", { days: "7", reason: "x" })).status === 403, "admin can't set retention");
  ({ t } = await text("/chat", "boss@x.com"));
  check(t.includes('action="/chat/retention"') && t.includes('name="reason"'), "the owner sees the retention form");
  let p = await s.post("/chat/retention", "boss@x.com", { days: "14", reason: "shorter for privacy" });
  check(p.status === 303, `owner sets 14 days (${p.status})`);
  const ra = audits("chat.retention")[0];
  check(ra?.actor === "boss@x.com" && ra.reason === "shorter for privacy" && (ra.params as any).from === 30 && (ra.params as any).to === 14 && ra.result === "ok", `retention change audited (${JSON.stringify(ra)})`);
  ({ t } = await text("/chat", "boss@x.com"));
  check(t.includes("14 days"), "the page shows the new retention");
  for (const days of ["0", "366", "abc", "7.5", ""]) {
    p = await s.post("/chat/retention", "boss@x.com", { days, reason: "r" });
    check(p.status === 400, `retention "${days}" → 400 (${p.status})`);
  }
  check((await s.post("/chat/retention", "boss@x.com", { days: "7", reason: "" })).status === 400, "retention needs a reason");
  ({ t } = await text("/chat", "boss@x.com"));
  check(t.includes("14 days"), "bad submissions left the retention alone");
} finally {
  await s.stop();
}
finish();
