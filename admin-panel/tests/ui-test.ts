// The new layout: CSP-clean pages, role-filtered navigation, self-hosted
// assets, the live Home view, and app.js never writing HTML.
import { makeChecker } from "../../tools/lib/harness.ts";
import { Client, sleep } from "../../tools/lib/staff-client.ts";
import { openStore } from "../src/store.ts";
import { startStack, readEvents } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "mod@x.com", role: "moderator", extras: [], linkedSwid: null });
store.upsertStaff("boss@x.com", { email: "adm@x.com", role: "admin", extras: [], linkedSwid: null });

try {
  const cleanPage = (name: string, t: string) => {
    check(!/\sstyle=/i.test(t), `${name}: no style attributes`);
    check(![...t.matchAll(/<script\b([^>]*)>/gi)].some((m) => !/\bsrc=/.test(m[1]!) && !/type="application\/json"/.test(m[1]!)), `${name}: no inline script code`);
    check(!/\son\w+=/i.test(t) && !/<(link|script|img)[^>]+(https?:)?\/\/(?!\/)/i.test(t), `${name}: no handlers, no external hosts`);
  };
  const pages: Record<string, string> = {};
  for (const p of ["/", "/me", "/staff", "/audit", "/cdn", "/more", "/nope"]) {
    const r = await s.get(p);
    pages[p] = await r.text();
    cleanPage(p, pages[p]);
  }
  check(pages["/"]!.includes('href="/static/panel.css"') && pages["/"]!.includes('src="/static/app.js"') && !pages["/"]!.includes("live.js"), "pages load panel.css and app.js only");
  check(/name="_csrf" value="[0-9a-f]{64}"/.test(pages["/me"]!), "the CSRF token is still in every page");
  check(/<nav[^>]*class="[^"]*side/.test(pages["/"]!) && /<nav[^>]*class="[^"]*tabbar/.test(pages["/"]!), "sidebar and bottom tab bar both rendered");

  const navOf = async (email: string) => {
    const t = await (await s.get("/", email)).text();
    return [...t.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  };
  const mod = await navOf("mod@x.com"), adm = await navOf("adm@x.com"), owner = await navOf("boss@x.com");
  check(["/", "/players", "/reports", "/more", "/me"].every((h) => mod.includes(h)), `moderator nav has Home, Players, Reports, More, Me (${mod})`);
  check(!["/staff", "/audit", "/cdn"].some((h) => mod.includes(h)), "moderator nav lacks Staff, Audit, CDN");
  check(["/staff", "/audit", "/cdn"].every((h) => adm.includes(h)), "admin nav has Staff, Audit, CDN");
  check(["/staff", "/audit", "/cdn"].every((h) => owner.includes(h)), "owner nav has Staff, Audit, CDN");
  const more = await (await s.get("/more", "mod@x.com")).text();
  check(more.includes('href="/me"') && !more.includes('href="/staff"') && !more.includes('href="/audit"'), "More lists only what the role may open");

  const home = pages["/"]!;
  check(/<form[^>]+action="\/players"[^>]+method="get"/i.test(home) || /<form[^>]+method="get"[^>]+action="\/players"/i.test(home), "Home has the player search form");
  for (const k of ["online", "openReports", "activeMutes", "activeBans"]) check(home.includes(`data-live="${k}"`), `Home has the ${k} tile`);
  check(home.includes('data-live-rooms'), "Home has the rooms-by-world area");

  for (const [path, type] of [["/static/app.js", "javascript"], ["/static/panel.css", "text/css"], ["/static/fonts/Inter-Regular.woff2", "font/woff2"], ["/static/fonts/JetBrainsMono-Regular.woff2", "font/woff2"], ["/static/fonts/OFL-Inter.txt", "text/plain"]] as const) {
    const r = await s.get(path);
    const body = await r.arrayBuffer();
    check(r.status === 200 && (r.headers.get("content-type") ?? "").includes(type) && body.byteLength > 100, `${path} → 200 ${type} (${r.status} ${r.headers.get("content-type")})`);
  }
  check((await s.get("/static/live.js")).status === 404, "the old live.js is gone");
  check((await s.get("/static/app.js", null)).status === 403, "assets still need Access");
  const css = await (await s.get("/static/panel.css")).text();
  check(css.includes("prefers-color-scheme: dark") && css.includes("@font-face") && css.includes("700px") && css.includes("900px") && !/url\(["']?https?:/.test(css), "css: dark mode, self-hosted fonts, mockup breakpoints, nothing external");
  const js = await (await s.get("/static/app.js")).text();
  check(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js) && js.includes("EventSource") && js.includes("textContent"), "app.js writes text only");

  const alice = new Client(s.servers, "{ui-alice}", "UiAlice");
  await alice.connect();
  let r = await s.get("/live/home", "mod@x.com");
  check(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/event-stream"), "/live/home opens an event stream");
  const ev = (await readEvents(r, 1))[0];
  check(ev?.game === "up" && ev.webapi === "up" && ev.online === 1 && ev.worlds.some((w: any) => w.rooms.some((x: any) => String(x.room).includes("Town") && x.count === 1)), `the event lists the connected player's room (${JSON.stringify(ev)})`);
  check(typeof ev?.openReports === "number" && typeof ev?.activeMutes === "number" && typeof ev?.activeBans === "number", "the event carries the moderation counts");
  check((await s.get("/live/dashboard")).status === 404, "the old /live/dashboard is gone");

  await s.servers.stopSfs();
  r = await s.get("/live/home");
  const down = (await readEvents(r, 1))[0];
  check(down?.game === "down" && down.webapi === "up", "game server down → game: down");
  check((await s.get("/")).status === 200, "Home still renders with the game server down");
  alice.sock.destroy();
} finally {
  await s.stop();
}
finish();
process.exit(0);
