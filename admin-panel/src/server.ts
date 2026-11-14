// The admin panel service. Binds 127.0.0.1 only; cloudflared publishes it
// behind Cloudflare Access. See README.md / DEPLOY.md.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { AccessVerifier } from "./access-jwt.ts";
import { openStore } from "./store.ts";
import { queryAudit } from "./audit.ts";
import { makeClients } from "./clients.ts";
import { makePipeline, withHeaders, type RouteDef } from "./pipeline.ts";
import { page, errorPage } from "./pages/layout.ts";
import { homeBody } from "./pages/home.ts";
import { moreBody } from "./pages/more.ts";
import { makeLive } from "./live.ts";
import { playerRoutes } from "./pages/players.ts";
import { reportRoutes } from "./pages/reports.ts";
import { filterRoutes } from "./pages/filter.ts";
import { chatRoutes } from "./pages/chat.ts";
import { templateRoutes } from "./pages/templates.ts";
import { makeActions } from "./actions.ts";
import { makeForms } from "./pages/action-forms.ts";
import { can } from "../shared/permissions.ts";
import { meBody } from "./pages/me.ts";
import { html } from "./web.ts";
import { makeRoleSync } from "./role-sync.ts";
import { staffRoutes } from "./pages/staff.ts";
import { auditRoutes } from "./pages/audit.ts";
import { cdnRoutes } from "./pages/cdn.ts";

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const store = openStore(cfg.dbPath, cfg.owners);
const verifier = new AccessVerifier({
  team: cfg.team, aud: cfg.aud,
  fetchKeys: cfg.testJwksFile ? async () => JSON.parse(readFileSync(cfg.testJwksFile!, "utf8")) : undefined,
});
const clients = makeClients(cfg.webapiUrl, cfg.gameUrl, cfg.secret);
const pipeline = makePipeline(cfg, verifier, store);

const STATIC_DIR = resolve(import.meta.dir, "../static");
const staticFile = (name: string, type: string): RouteDef => {
  const body = readFileSync(`${STATIC_DIR}/${name}`);
  return { action: "dashboard.view", method: "GET", run: async () => new Response(body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=300" } }) };
};

const live = makeLive(clients, store);

const routes: Record<string, RouteDef> = {
  "GET /": {
    action: "dashboard.view", method: "GET",
    run: async ({ staff, csrf }) => {
      const ok = (a: string) => can(staff.role, staff.extras, a);
      const recent = ok("audit.view") ? queryAudit(store, { limit: 8 }) : null;
      return page({ title: "Home", staff, csrf, active: "home", body: homeBody({ canPlayers: ok("players.view"), canReports: ok("reports.view"), recent }) });
    },
  },
  "GET /live/home": {
    action: "players.view", method: "GET",
    run: async ({ actor, staff, req }) => new Response(live.subscribe(staff, actor, req.signal), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } }),
  },
  "GET /more": {
    action: "dashboard.view", method: "GET",
    run: async ({ staff, csrf }) => page({ title: "More", staff, csrf, active: "more", body: moreBody(staff) }),
  },
  "GET /me": {
    action: "dashboard.view", method: "GET",
    run: async ({ staff, csrf }) => page({ title: "Me", staff, csrf, body: meBody(staff, queryAudit(store, { actor: staff.email, limit: 50 })) }),
  },
  "GET /static/app.js": staticFile("app.js", "text/javascript; charset=utf-8"),
  "GET /static/panel.css": staticFile("panel.css", "text/css; charset=utf-8"),
};
// Fonts and their licenses: a fixed list, never a path taken from the request.
for (const [name, type] of [["Inter-Regular.woff2", "font/woff2"], ["Inter-Medium.woff2", "font/woff2"], ["Inter-SemiBold.woff2", "font/woff2"], ["JetBrainsMono-Regular.woff2", "font/woff2"], ["JetBrainsMono-Medium.woff2", "font/woff2"], ["OFL-Inter.txt", "text/plain; charset=utf-8"], ["OFL-JetBrainsMono.txt", "text/plain; charset=utf-8"]] as const) {
  routes[`GET /static/fonts/${name}`] = staticFile(`fonts/${name}`, type);
}

const roleSync = makeRoleSync(clients, store);
const actions = makeActions(clients, store);
const players = playerRoutes(clients, store, makeForms(clients, store, actions), actions);
const reports = reportRoutes(clients, store, actions);
const filter = filterRoutes(clients, store), templates = templateRoutes(store);
const chat = chatRoutes(clients, store);
Object.assign(routes, players.exact, reports.exact, filter.exact, chat.exact, templates.exact, staffRoutes(store, roleSync), auditRoutes(store), cdnRoutes(clients, store, { dir: cfg.uploadDir, maxBytes: cfg.uploadMaxBytes }));

// Disabled staff (incl. emails taken out of PANEL_OWNERS) lose their game
// role too: now, and every 10 minutes in case a server was down.
const RECONCILE_MS = 10 * 60_000;
const reconcile = () => roleSync.reconcileDisabled().catch((err) => console.error(`[PANEL] reconcile failed: ${(err as Error).message}`));
reconcile();
setInterval(reconcile, RECONCILE_MS);

// Unknown pages still go through the pipeline, so a non-staff request gets
// the same 403 and learns nothing about which pages exist.
const notFound: RouteDef = {
  action: "dashboard.view", method: "GET",
  run: async ({ staff, csrf }) => withHeaders(new Response(page({ title: "Not found", staff, csrf, body: html`<p>No such page.</p>` }).toString(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } })),
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: cfg.port,
  idleTimeout: 30,
  // Never Bun's development error page (it shows messages and stacks).
  development: false,
  error(err) {
    console.error(`[PANEL] unhandled: ${err.stack}`);
    return withHeaders(new Response(errorPage(500, "Something went wrong. It has been logged.").toString(), { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  },
  fetch(req) {
    const url = new URL(req.url);
    const route = routes[`${req.method} ${url.pathname}`] ?? players.match(req.method, url.pathname) ?? reports.match(req.method, url.pathname) ?? filter.match(req.method, url.pathname) ?? templates.match(req.method, url.pathname) ?? notFound;
    return pipeline.handle(req, route);
  },
});
console.log(`[PANEL] admin panel on http://127.0.0.1:${server.port} for https://${cfg.host}`);
