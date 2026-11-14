// Panel service: the request pipeline (Access JWT, staff list, headers),
// Home's live view over SSE, the Me page, and refusing to start
// with missing configuration.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { sleep } from "../../tools/lib/staff-client.ts";
import { startStack, readEvents, accessToken, REPO, TEAM, AUD } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const s = await startStack(["boss@x.com"]);

try {
  let r = await s.get("/", null);
  check(r.status === 403 && r.headers.get("content-security-policy") === CSP, `no JWT → 403, still with security headers (${r.status})`);
  check(!(await r.text()).includes("Home"), "the 403 page shows nothing of the panel");
  r = await s.get("/", null, { "Cf-Access-Jwt-Assertion": accessToken("boss@x.com", { aud: ["another-app"] }) });
  check(r.status === 403, "JWT for another Access app → 403");
  r = await s.get("/", null, { "Cf-Access-Jwt-Assertion": "garbage" });
  check(r.status === 403, "garbage JWT → 403, not 500");
  r = await s.get("/", "stranger@x.com");
  check(r.status === 403, "valid JWT, not on the staff list → 403");

  r = await s.get("/", "Boss@X.com");
  const page = await r.text();
  check(r.status === 200 && page.includes("Home"), `PANEL_OWNERS owner sees Home (${r.status})`);
  check(r.headers.get("content-security-policy") === CSP && r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("referrer-policy") === "same-origin", "Home has the security headers");
  check(page.includes('<script src="/static/app.js"') && !/<script>(?!<\/script>)/.test(page) && !/ on\w+=/.test(page), "only the external script, no inline script or handlers");

  r = await s.get("/live/home");
  check(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/event-stream"), "SSE stream opens");
  let ev = await readEvents(r, 1);
  check(ev[0]?.webapi === "up" && ev[0]?.game === "up" && ev[0]?.online === 0, `first event: both up, 0 online (${JSON.stringify(ev[0])})`);

  r = await s.get("/static/app.js");
  const js = await r.text();
  check(r.status === 200 && (r.headers.get("content-type") ?? "").includes("javascript") && js.includes("EventSource") && !js.includes("innerHTML"), "app.js served, uses EventSource and never innerHTML");

  await s.servers.stopSfs();
  r = await s.get("/live/home");
  ev = await readEvents(r, 1);
  check(ev[0]?.game === "down" && ev[0]?.webapi === "up", `game server stopped → game: down (${JSON.stringify(ev[0])})`);
  r = await s.get("/");
  check(r.status === 200, "Home still renders with the game server down");

  r = await s.get("/me");
  const me = await r.text();
  check(r.status === 200 && me.includes("boss@x.com") && me.includes("owner"), "Me shows email and role");
  check(/name="_csrf" value="[0-9a-f]{64}"/.test(me), "pages carry a CSRF token");

  check((await s.get("/nope")).status === 404, "unknown page → 404");

  // If the audit log can't be written, denials still answer cleanly and
  // nothing internal reaches the browser.
  const raw = new Database(s.dbPath);
  raw.run("CREATE TRIGGER no_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit write failed'); END");
  r = await s.get("/", "stranger@x.com");
  const t = await r.text();
  check(r.status === 403 && !t.includes("audit write failed") && !/\bat .*\.ts:\d+/.test(t), `audit failure on a deny path → still 403, no internals (${r.status} ${t.slice(0, 80)})`);
  raw.run("DROP TRIGGER no_audit");
  raw.close();
  check((await s.get("/audit", "stranger@x.com")).status === 403, "non-staff → 403 on other pages too");

  // Startup refuses missing configuration and names it.
  const env = { ...process.env, NODE_ENV: "test", CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, ADMIN_PANEL_SECRET: "f".repeat(64), PANEL_OWNERS: "boss@x.com", PANEL_HOST: "h", ADMIN_PANEL_PORT: "1" };
  const bad = Bun.spawnSync(["bun", "run", `${REPO}/admin-panel/src/server.ts`], { env, stderr: "pipe", stdout: "pipe" });
  check(bad.exitCode !== 0 && bad.stderr.toString().includes("PANEL_CSRF_KEY"), `missing PANEL_CSRF_KEY → exits non-zero naming it (${bad.exitCode})`);
  const short = Bun.spawnSync(["bun", "run", `${REPO}/admin-panel/src/server.ts`], { env: { ...env, PANEL_CSRF_KEY: "x".repeat(64), ADMIN_PANEL_SECRET: "abc" }, stderr: "pipe", stdout: "pipe" });
  check(short.exitCode !== 0 && short.stderr.toString().includes("ADMIN_PANEL_SECRET"), "short ADMIN_PANEL_SECRET → exits naming it");
  const noTestKeys = Bun.spawnSync(["bun", "run", `${REPO}/admin-panel/src/server.ts`], { env: { ...env, NODE_ENV: "production", PANEL_CSRF_KEY: "x".repeat(64), PANEL_TEST_JWKS_FILE: "/tmp/x.json", ADMIN_PANEL_PORT: "0" }, stderr: "pipe", stdout: "pipe", timeout: 3000 });
  check(noTestKeys.stderr.toString().includes("PANEL_TEST_JWKS_FILE is ignored") || noTestKeys.exitCode !== 0, "test keys are refused outside NODE_ENV=test");
  await sleep(10);
} finally {
  await s.stop();
}
finish(s.logs());
