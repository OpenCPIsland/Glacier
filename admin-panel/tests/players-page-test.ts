// Players list, search, the player page and staff notes.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { Client } from "../../tools/lib/staff-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack, accessToken } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const api = s.servers.api;
const store = openStore(s.dbPath, ["boss@x.com"]);
for (const [email, role] of [["mod@x.com", "moderator"], ["mod2@x.com", "moderator"], ["adm@x.com", "admin"]] as const)
  store.upsertStaff("boss@x.com", { email, role, extras: [], linkedSwid: null });

const EVIL = "Pg<b>x</b>\u202eevil";
const ALICE = "{pg-alice}", BOB = "{pg-bob}", EVILSWID = "{pg-evil}", BOSS = "{pg-boss}";
const pu = (swid: string) => `/players/${encodeURIComponent(swid)}`;
for (const [swid, name] of [[ALICE, "PgAlice"], [BOB, "PgBob"], [EVILSWID, EVIL], [BOSS, "PgBoss"]] as const) await createPlayer(api.base, api.dbPath, swid, name);
const text = async (path: string, email = "mod@x.com") => { const r = await s.get(path, email); return { r, t: await r.text() }; };

try {
  // Online table
  const alice = new Client(s.servers, ALICE, "PgAlice");
  await alice.connect();
  let { r, t } = await text("/players");
  check(r.status === 200 && t.includes("Online now") && t.includes("Town") && t.includes(encodeURIComponent(ALICE)), "/players lists who is online with room and a link to the player");
  check(/<form[^>]+action="\/players"/.test(t) && t.includes('name="q"'), "the list page has the search form");

  // Search
  const noFollow = (path: string) => fetch(s.panel + path, { redirect: "manual", headers: { "Cf-Access-Jwt-Assertion": accessToken("mod@x.com") } });
  r = await noFollow("/players?q=PgAli");
  check(r.status === 303 && r.headers.get("location") === pu(ALICE), `one exact-ish hit redirects to the player (${r.status} ${r.headers.get("location")})`);
  r = await noFollow("/players/search?q=PgAli");
  check(r.status === 303 && r.headers.get("location") === pu(ALICE), "/players/search is the same search");
  ({ r, t } = await text("/players?q=Pg"));
  check(r.status === 200 && t.includes("PgAlice") && t.includes("PgBob") && t.includes("PgBoss"), "several hits are listed");
  ({ t } = await text("/players?q=zzzznobody"));
  check(t.includes("No players match"), "no hit says so");
  ({ t } = await text(`/players?q=${encodeURIComponent("<")}`));
  check(!t.includes("<b>x") && t.includes("&lt;"), "the query is echoed escaped");

  // Player page
  ({ r, t } = await text(pu(ALICE)));
  check(r.status === 200 && t.includes("PgAlice") && t.includes("Online"), "player page shows the name and that they're online");
  for (const a of ["kick", "mute", "warn", "ban"]) check(t.includes(`href="${pu(ALICE)}/${a}"`), `moderator sees the ${a} action`);
  check(!t.includes("Permanent") && !t.includes("/ban/permanent"), "moderator is not offered permanent bans");
  check(!t.includes("Chat (2b)") && !t.includes('aria-disabled="true"'), "no disabled Chat (2b) placeholder any more");
  for (const tab of ["history", "reports", "notes", "chat"]) check(t.includes(`?tab=${tab}`), `tab ${tab} linked`);
  check(!/\sstyle=/i.test(t) && ![...t.matchAll(/<script\b([^>]*)>/gi)].some((m) => !/\bsrc=/.test(m[1]!) && !/application\/json/.test(m[1]!)), "player page is CSP-clean");

  // History
  const db = new Database(api.dbPath);
  db.run("INSERT INTO mix_sanctions (swid, type, level, moderator, reason) VALUES (?, 'HARASSMENT', 2, 'cli', ?)", [ALICE, "said <i>rude</i> things"]);
  db.close();
  ({ t } = await text(`${pu(ALICE)}?tab=history`));
  check(/<time datetime="[^"]+"/.test(t) && t.includes("HARASSMENT") && t.includes("said &lt;i&gt;rude&lt;/i&gt; things"), "history lists the sanction with <time> and an escaped reason");
  ({ t } = await text(`${pu(ALICE)}?tab=reports`));
  check(t.includes("Reports against") && t.includes("Reports made"), "reports tab");

  // Hostile name
  ({ t } = await text(pu(EVILSWID)));
  check(!t.includes("<b>x</b>") && t.includes("&lt;b&gt;x&lt;/b&gt;") && !t.includes("\u202e"), "a hostile name is escaped, bidi shown as an escape, in the header");
  ({ t } = await text("/players?q=Pg"));
  check(t.includes("&lt;b&gt;x&lt;/b&gt;") && !t.includes("<b>x</b>") && !t.includes("\u202e"), "and in search results");

  // Notes
  let res = await s.post(`${pu(ALICE)}/notes`, "mod@x.com", { body: "watch <script>alert(1)</script> this one" });
  check(res.status === 303 && (res.headers.get("location") ?? "").includes("tab=notes"), `adding a note redirects back to the notes tab (${res.status})`);
  ({ t } = await text(`${pu(ALICE)}?tab=notes`));
  check(t.includes("watch &lt;script&gt;alert(1)&lt;/script&gt; this one") && !t.includes("<script>alert"), "the note shows, escaped");
  const noteId = t.match(new RegExp(`${encodeURIComponent(ALICE).replace(/[{}]/g, "\\$&")}/notes/(\\d+)/delete`))?.[1];
  check(!!noteId, "the note has a delete action");
  check(queryAudit(store, { action: "notes.edit", limit: 5 }).some((a) => a.target === ALICE && a.actor === "mod@x.com" && a.result === "ok"), "adding a note is audited as notes.edit");
  res = await s.post(`${pu(ALICE)}/notes`, "mod@x.com", { body: "   " });
  check(res.status === 400, "an empty note is refused");
  res = await s.post(`${pu(ALICE)}/notes`, "mod@x.com", { body: "x".repeat(1001) });
  check(res.status === 400, "an over-long note is refused");
  res = await s.post(`${pu(ALICE)}/notes`, "mod@x.com", { body: "no csrf" }, { csrf: null });
  check(res.status === 403, "no CSRF token → 403");
  res = await s.post(`${pu(BOB)}/notes/${noteId}/delete`, "adm@x.com", {});
  check(res.status === 404, "a note can't be deleted (or audited) through another player's URL");
  check(!queryAudit(store, { action: "notes.edit", limit: 20 }).some((a) => a.target === BOB), "and nothing is audited against the wrong player");
  res = await s.post(`${pu(ALICE)}/notes/${noteId}/delete`, "mod2@x.com", {});
  check(res.status === 403, "another moderator can't delete someone else's note");
  res = await s.post(`${pu(ALICE)}/notes/${noteId}/delete`, "adm@x.com", {});
  check(res.status === 303, "an admin can");
  ({ t } = await text(`${pu(ALICE)}?tab=notes`));
  check(!t.includes("alert(1)"), "a deleted note is gone from the list");
  res = await s.post(`${pu(ALICE)}/notes/99999/delete`, "adm@x.com", {});
  check(res.status === 404, "deleting an unknown note → 404");

  // Unknown / malformed
  ({ r, t } = await text(pu("{nobody-here}")));
  check(r.status === 404 && t.includes("No such player"), "unknown swid → 404 page");
  r = await s.get("/players/not-a-swid", "mod@x.com");
  check(r.status === 404, "malformed swid → 404");

  // Rank rule: a moderator is not offered actions on an in-game admin
  await fetch(`${api.base}/api/internal/set-role`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ username: (await new Client(s.servers, BOSS, "PgBoss").account()), role: "admin" }) });
  ({ t } = await text(pu(BOSS)));
  check(!t.includes(`${pu(BOSS)}/kick`) && t.includes("act on a player of this rank"), "a moderator gets no actions on an in-game admin");
  ({ t } = await text(pu(BOSS), "boss@x.com"));
  check(t.includes(`${pu(BOSS)}/kick`), "the owner does");

  // Moderator without notes access? every moderator has it; a viewer without players.view is refused
  check((await s.get("/players", null)).status === 403, "no JWT → 403");

  // Web API down
  await api.stop();
  ({ r, t } = await text("/players?q=Pg"));
  check(r.status === 200 && t.includes("The web API isn't answering"), "web API down → says so, page still renders");
  ({ r, t } = await text(pu(ALICE)));
  check(r.status === 200 && t.includes("The web API isn't answering"), "player page too");
  alice.sock.destroy();
} finally {
  await s.stop();
}
finish();
process.exit(0);
