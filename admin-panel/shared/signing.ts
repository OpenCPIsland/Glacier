// Signed calls from the panel to the web-api and game-server admin
// modules. The signature covers who is acting, as what, doing what, and
// the exact request, so a captured call can't be replayed or edited.
// This catches panel bugs and replays; it does not protect a leaked
// ADMIN_PANEL_SECRET.
import crypto from "node:crypto";
import { can, isRole, type Role } from "./permissions.ts";

export interface Actor {
  email: string;
  role: Role;
  extras: string[];
}

export const WINDOW_MS = 30_000;
const NONCE_TTL_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function signature(secret: string, method: string, path: string, ts: string, nonce: string, actor: string, role: string, extras: string, action: string, body: string): string {
  const payload = [method.toUpperCase(), path, ts, nonce, actor, role, extras, action, sha256hex(body)].join("\n");
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function signHeaders(secret: string, method: string, path: string, body: string, actor: Actor, action: string, now = Date.now()): Record<string, string> {
  const ts = String(now);
  const nonce = crypto.randomBytes(16).toString("hex");
  const extras = [...actor.extras].sort().join(",");
  return {
    "X-Admin-Actor": actor.email,
    "X-Admin-Role": actor.role,
    "X-Admin-Extras": extras,
    "X-Admin-Action": action,
    "X-Admin-Ts": ts,
    "X-Admin-Nonce": nonce,
    "X-Admin-Sig": signature(secret, method, path, ts, nonce, actor.email, actor.role, extras, action, body),
  };
}

export class NonceCache {
  private seenAt = new Map<string, number>();

  /** True if the nonce was already used within the last 60 s; records it otherwise. */
  seen(nonce: string, now: number): boolean {
    for (const [n, at] of this.seenAt) {
      if (now - at <= NONCE_TTL_MS) break; // Map keeps insertion order, oldest first
      this.seenAt.delete(n);
    }
    if (this.seenAt.has(nonce)) return true;
    this.seenAt.set(nonce, now);
    return false;
  }
}

export interface SignedRequest {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string | undefined;
}

export type VerifyResult =
  | { ok: true; actor: Actor; action: string }
  | { ok: false; status: 401 | 403; why: string };

function header(headers: SignedRequest["headers"], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

export function verifySigned(secret: string, req: SignedRequest, nonces: NonceCache, now = Date.now()): VerifyResult {
  if (!LOOPBACK.has(req.remoteAddress ?? "")) return { ok: false, status: 403, why: "not loopback" };
  const h = (n: string) => header(req.headers, n);
  const actor = h("X-Admin-Actor"), role = h("X-Admin-Role"), extras = h("X-Admin-Extras");
  const action = h("X-Admin-Action"), ts = h("X-Admin-Ts"), nonce = h("X-Admin-Nonce"), sig = h("X-Admin-Sig");
  if (!actor || !role || extras === undefined || !action || !ts || !nonce || !sig) return { ok: false, status: 401, why: "missing headers" };
  if (!isRole(role)) return { ok: false, status: 401, why: "bad role" };
  if (!/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, status: 401, why: "bad ts or nonce" };

  const expected = signature(secret, req.method, req.path, ts, nonce, actor, role, extras, action, req.body);
  const given = Buffer.from(sig), want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return { ok: false, status: 401, why: "bad signature" };
  if (Math.abs(now - Number(ts)) > WINDOW_MS) return { ok: false, status: 401, why: "stale" };
  if (nonces.seen(nonce, now)) return { ok: false, status: 401, why: "replay" };

  const extraList = extras === "" ? [] : extras.split(",");
  if (!can(role, extraList, action)) return { ok: false, status: 403, why: "not permitted" };
  return { ok: true, actor: { email: actor, role, extras: extraList }, action };
}
