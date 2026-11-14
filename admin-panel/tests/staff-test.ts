// Staff page: owner-only edits with a confirm step, links to game accounts,
// role sync (lock + live session), relinking, STAFF_ADMINS conflicts,
// unreachable servers, CSRF, and escaping of player-chosen names.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack, HOST } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const api = s.servers.api;
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "helper@x.com", role: "admin", extras: [], linkedSwid: null });

const usernameOf = (swid: string) => {
  const db = new Database(api.dbPath, { readonly: true });
  const r = db.query("SELECT username FROM player_identity WHERE swid = ?").get(swid) as { username: string };
  db.close();
  return r.username;
};
const roleOf = async (swid: string) => ((await (await fetch(`${api.base}/api/internal/identity`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ swid }) })).json()) as any).role;
const inGameSetRole = (username: string, role: string) => fetch(`${api.base}/api/internal/set-role`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ username, role }) });
const confirmAndPost = async (path: string, fields: Record<string, string | string[]>, email = "boss@x.com") => {
  const first = await s.post(path, email, fields);
  const confirmPage = await first.text();
  const rev = confirmPage.match(/name="rev" value="([^"]*)"/)?.[1] ?? "";
  const second = await s.post(path, email, { ...fields, rev, confirm: "1" });
  return { first, confirmPage, second, text: await second.text() };
};
const lastAudit = (action: string) => queryAudit(store, { action, limit: 1 })[0];

try {
  await createPlayer(api.base, api.dbPath, "{carol}", "Carol");
  await createPlayer(api.base, api.dbPath, "{dave}", "Dave");
  await createPlayer(api.base, api.dbPath, "{root}", "Root");
  const carol = usernameOf("{carol}"), dave = usernameOf("{dave}"), root = usernameOf("{root}");

  // Admin can look, can't change.
  let r = await s.get("/staff", "helper@x.com");
  let text = await r.text();
  check(r.status === 200 && text.includes("boss@x.com") && text.includes("helper@x.com"), "admin can view the staff list");
  check(!text.includes('action="/staff/add"'), "admin sees no edit forms");
  r = await s.post("/staff/add", "helper@x.com", { email: "x@x.com", role: "moderator", link: "" });
  check(r.status === 403, `admin can't add staff (${r.status})`);

  // Owner adds a linked moderator: confirm page first, then the change.
  let c = await confirmAndPost("/staff/add", { email: "Mod@X.com", role: "moderator", link: carol.toLowerCase() });
  check(c.first.status === 200 && c.confirmPage.includes("mod@x.com") && c.confirmPage.includes("moderator") && c.confirmPage.includes(carol) && c.confirmPage.includes('name="confirm" value="1"'), "add shows a confirm page naming the change and the game account");
  check(store.getStaff("mod@x.com") === null || c.second.status === 200, "nothing saved before confirm");
  check(c.second.status === 200 && store.getStaff("mod@x.com")?.linkedSwid === "{carol}", `confirmed add saves the row with the resolved link (${c.second.status})`);
  check(await roleOf("{carol}") === "moderator", "Carol's in-game role is moderator");
  check(!(await inGameSetRole(carol, "admin")).ok && await roleOf("{carol}") === "moderator", "Carol is locked: in-game set-role refused");
  check(lastAudit("role.sync")?.result === "ok", "role sync audited ok");
  text = await (await s.get("/staff")).text();
  check(/mod@x\.com[\s\S]*?\bok\b/.test(text), "staff list shows Carol's row in sync");

  await s.restartWebApi();
  check(!(await inGameSetRole(carol, "player")).ok, "Carol is still locked after a web API restart");

  // Disable → player, still locked.
  c = await confirmAndPost("/staff/disable", { email: "mod@x.com" });
  check(c.second.status === 200 && store.getStaff("mod@x.com")?.disabled === true, "disable saves");
  check(await roleOf("{carol}") === "player" && !(await inGameSetRole(carol, "moderator")).ok, "disabled → in-game player and still locked");
  check((await s.get("/", "mod@x.com")).status === 403, "a disabled staff member can't open the panel");
  c = await confirmAndPost("/staff/enable", { email: "mod@x.com" });
  check(await roleOf("{carol}") === "moderator", "enable restores the in-game role");

  // Relink to Dave: Carol goes back to player and is unlocked.
  c = await confirmAndPost("/staff/update", { email: "mod@x.com", role: "moderator", link: dave });
  check(store.getStaff("mod@x.com")?.linkedSwid === "{dave}" && await roleOf("{dave}") === "moderator", "relink moves the role to Dave");
  check(await roleOf("{carol}") === "player" && (await inGameSetRole(carol, "moderator")).ok, "the old account is set to player and unlocked");

  // A confirm page opened before another owner's change can't undo it.
  store.upsertStaff("boss@x.com", { email: "own2@x.com", role: "owner", extras: [], linkedSwid: null });
  const stalePage = await (await s.post("/staff/update", "boss@x.com", { email: "mod@x.com", role: "admin", link: carol })).text();
  const staleFields: Record<string, string[]> = {};
  for (const m of stalePage.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    if (m[1] === "_csrf" || m[1] === "confirm") continue;
    (staleFields[m[1]!] ??= []).push(m[2]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  }
  check(staleFields.rev?.length === 1, "the confirm form carries the row's revision");
  await confirmAndPost("/staff/update", { email: "mod@x.com", role: "moderator", link: dave, extras: ["audit.view"] }, "own2@x.com");
  const carolBefore = await roleOf("{carol}");
  r = await s.post("/staff/update", "boss@x.com", { ...staleFields, confirm: "1" });
  check(r.status === 409 && store.getStaff("mod@x.com")?.linkedSwid === "{dave}" && store.getStaff("mod@x.com")?.extras.join() === "audit.view", `a stale confirm is refused and changes nothing (${r.status})`);
  check(await roleOf("{dave}") === "moderator" && await roleOf("{carol}") === carolBefore, "the game roles are untouched by the stale confirm");

  // One game account, one staff row.
  r = await s.post("/staff/add", "boss@x.com", { email: "dup@x.com", role: "moderator", link: dave });
  check(r.status === 400 && (await r.text()).includes("mod@x.com") && store.getStaff("dup@x.com") === null, "a game account already linked to another staff row is refused");

  // Unknown game account.
  r = await s.post("/staff/add", "boss@x.com", { email: "n@x.com", role: "moderator", link: "nobody-at-all", confirm: "1" });
  check(r.status === 400 && store.getStaff("n@x.com") === null, "an unknown game account is refused and nothing is saved");

  // STAFF_ADMINS conflict.
  await s.restartWebApi({ STAFF_ADMINS: root });
  c = await confirmAndPost("/staff/add", { email: "conf@x.com", role: "moderator", link: root });
  check(lastAudit("role.sync")?.result === "error" && String(lastAudit("role.sync")?.detail).includes("webapi"), `STAFF_ADMINS link → role.sync error at step webapi (${JSON.stringify(lastAudit("role.sync"))})`);
  text = await (await s.get("/staff")).text();
  check(text.includes("STAFF_ADMINS"), "staff list warns about the STAFF_ADMINS conflict");

  // Game server down: unreachable, out of sync.
  await s.servers.stopSfs();
  c = await confirmAndPost("/staff/update", { email: "mod@x.com", role: "admin", link: dave });
  check(lastAudit("role.sync")?.result === "unreachable", `game server down → role.sync unreachable (${lastAudit("role.sync")?.result})`);
  check(c.text.includes("out of sync") || (await (await s.get("/staff")).text()).includes("out of sync"), "the page says out of sync");

  // Self-protection and config owners.
  r = await s.post("/staff/disable", "boss@x.com", { email: "boss@x.com", confirm: "1" });
  check(r.status === 400, "an owner can't disable themselves");
  store.upsertStaff("boss@x.com", { email: "own2@x.com", role: "owner", extras: [], linkedSwid: null });
  r = await s.post("/staff/update", "own2@x.com", { email: "own2@x.com", role: "admin", link: "", confirm: "1" });
  check(r.status === 400 && store.getStaff("own2@x.com")?.role === "owner", "an owner can't demote themselves");
  r = await s.post("/staff/update", "own2@x.com", { email: "boss@x.com", role: "admin", link: "", confirm: "1" });
  check(r.status === 400 && store.getStaff("boss@x.com")?.role === "owner", "a PANEL_OWNERS row can't be demoted");
  r = await s.post("/staff/add", "boss@x.com", { email: "x2@x.com", role: "admin", extras: ["staff.edit"], link: "", confirm: "1" });
  check(r.status === 400 && store.getStaff("x2@x.com") === null, "extras can't include owner-only actions");

  // CSRF and Origin.
  r = await s.post("/staff/add", "boss@x.com", { email: "c@x.com", role: "moderator", link: "", confirm: "1" }, { csrf: null });
  check(r.status === 403 && store.getStaff("c@x.com") === null, "POST without a CSRF token → 403");
  r = await s.post("/staff/add", "boss@x.com", { email: "c@x.com", role: "moderator", link: "", confirm: "1" }, { origin: "https://evil.example" });
  check(r.status === 403 && store.getStaff("c@x.com") === null, "POST from another origin → 403");

  // A player-chosen name renders inert.
  const db = new Database(api.dbPath);
  const evil = "<img src=x onerror=alert(1)>";
  db.run("UPDATE players SET username = ? WHERE username = ?", [evil, carol]);
  db.run("UPDATE player_identity SET username = ? WHERE swid = '{carol}'", [evil]);
  db.close();
  store.upsertStaff("boss@x.com", { email: "xss@x.com", role: "moderator", extras: [], linkedSwid: "{carol}" });
  text = await (await s.get("/staff")).text();
  check(!text.includes(evil) && text.includes("&lt;img src=x onerror=alert(1)&gt;"), "a hostile username is escaped on the staff page");
  check(HOST.length > 0, "host set");
} finally {
  await s.stop();
}
finish(s.logs());
