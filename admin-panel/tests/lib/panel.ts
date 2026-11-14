// Test helpers for the panel service: a fake Cloudflare Access key set,
// tokens for it, and the panel + web API + game server, all with the
// admin modules preloaded.
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServers, sleep, type Servers } from "../../../tools/lib/staff-client.ts";

export const REPO = resolve(import.meta.dir, "../../..");
export const TEAM = "iceberg-test";
export const AUD = "panel-aud";
export const HOST = "admin.test.example";
export const SECRET = "f".repeat(64);

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "t1", alg: "RS256", use: "sig" };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function accessToken(email: string, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: "t1", typ: "JWT" });
  const body = b64({ aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, email, iat: now, nbf: now, exp: now + 3600, ...over });
  return `${head}.${body}.${crypto.sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

export interface Stack {
  servers: Servers;
  panel: string;
  dbPath: string;
  /** Where the panel leaves uploaded zips, and where the web API keeps imported CDN releases. */
  uploadDir: string;
  releasesDir: string;
  logs: () => string;
  get(path: string, email?: string | null, headers?: Record<string, string>): Promise<Response>;
  post(path: string, email: string, fields: Record<string, string | string[]>, opts?: { csrf?: string | null; origin?: string | null }): Promise<Response>;
  /** A multipart POST (file uploads); the CSRF token is added to the form. */
  postForm(path: string, email: string, form: FormData, opts?: { csrf?: string | null; origin?: string | null }): Promise<Response>;
  csrfFor(email: string): Promise<string>;
  /** Restarts the panel, optionally with changed env (e.g. PANEL_OWNERS). */
  restartPanel(extra?: Record<string, string>): Promise<void>;
  /** Restarts the web API with the admin preload kept, plus extra env (e.g. STAFF_ADMINS). */
  restartWebApi(extra?: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
}

export async function startStack(owners: string[] = ["boss@x.com"]): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "panel-"));
  const jwksFile = join(dir, "jwks.json");
  writeFileSync(jwksFile, JSON.stringify({ keys: [jwk] }));
  const base = 20000 + (process.pid % 2000) * 3;
  const [webPort, sfsPort, panelPort] = [base, base + 1, base + 2];
  const servers = await startServers({ sfsEnv: { BUN_OPTIONS: `--preload=${REPO}/smartfox-server/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, SFS_ADMIN_PORT: String(sfsPort) } });
  const uploadDir = join(dir, "uploads"), releasesDir = join(dir, "releases");
  mkdirSync(uploadDir); mkdirSync(releasesDir);
  const webEnv = { CDN_STAGING_DIR: uploadDir, CDN_RELEASES_DIR: releasesDir, ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: servers.key, BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(webPort) };
  await servers.api.restart(webEnv);
  const dbPath = join(dir, "admin.db");
  const env = {
    ...process.env, NODE_ENV: "test", PANEL_TEST_JWKS_FILE: jwksFile,
    ADMIN_PANEL_PORT: String(panelPort), PANEL_HOST: HOST, PANEL_DB: dbPath,
    CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, ADMIN_PANEL_SECRET: SECRET, PANEL_CSRF_KEY: "a1".repeat(32),
    CDN_UPLOAD_DIR: uploadDir, PANEL_OWNERS: owners.join(","), WEBAPI_ADMIN_PORT: String(webPort), SFS_ADMIN_PORT: String(sfsPort),
  };
  let out = "";
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const panel = `http://127.0.0.1:${panelPort}`;
  const launch = async () => {
    proc = Bun.spawn(["bun", "run", `${REPO}/admin-panel/src/server.ts`], { cwd: `${REPO}/admin-panel`, env, stdout: "pipe", stderr: "pipe" });
    const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) out += new TextDecoder().decode(c); };
    pump(proc.stdout as ReadableStream<Uint8Array>); pump(proc.stderr as ReadableStream<Uint8Array>);
    for (let i = 0; i < 100; i++) { try { await fetch(panel + "/"); return; } catch { await sleep(100); } }
    throw new Error(`panel did not start:\n${out}`);
  };
  await launch();
  const authed = (email: string | null | undefined): Record<string, string> => (email ? { "Cf-Access-Jwt-Assertion": accessToken(email) } : {});
  const stack: Stack = {
    servers, panel, dbPath, uploadDir, releasesDir, logs: () => out,
    get: (path, email = "boss@x.com", headers = {}) => fetch(panel + path, { headers: { ...authed(email), ...headers } }),
    async csrfFor(email) {
      const page = await (await stack.get("/me", email)).text();
      return page.match(/name="_csrf" value="([0-9a-f]{64})"/)?.[1] ?? "";
    },
    async post(path, email, fields, opts = {}) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) form.append(k, x);
      const csrf = opts.csrf === undefined ? await stack.csrfFor(email) : opts.csrf;
      if (csrf !== null) form.append("_csrf", csrf);
      const origin = opts.origin === undefined ? `https://${HOST}` : opts.origin;
      return fetch(panel + path, {
        method: "POST", redirect: "manual", body: form,
        headers: { ...authed(email), "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) },
      });
    },
    async postForm(path, email, form, opts = {}) {
      const csrf = opts.csrf === undefined ? await stack.csrfFor(email) : opts.csrf;
      if (csrf !== null) form.append("_csrf", csrf);
      const origin = opts.origin === undefined ? `https://${HOST}` : opts.origin;
      return fetch(panel + path, { method: "POST", redirect: "manual", body: form, headers: { ...authed(email), ...(origin ? { Origin: origin } : {}) } });
    },
    async restartPanel(extra = {}) { proc?.kill(); await proc?.exited; Object.assign(env, extra); await launch(); },
    async restartWebApi(extra = {}) {
      await servers.api.restart({ ...webEnv, ...extra });
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${webPort}/`); return; } catch { await sleep(100); } }
    },
    async stop() { proc?.kill(); await proc?.exited; await servers.stop(); },
  };
  return stack;
}

/** Reads SSE events from a response until `n` events or the timeout. */
export async function readEvents(res: Response, n: number, timeoutMs = 15_000): Promise<any[]> {
  const reader = res.body!.getReader();
  const events: any[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    buf += new TextDecoder().decode(r.value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) events.push(JSON.parse(data));
    }
  }
  reader.cancel().catch(() => {});
  return events;
}
