// Verifies the Cf-Access-Jwt-Assertion header Cloudflare Access adds to
// every request it lets through. A request without a valid one never
// passed through Access (or is for another Access app) and is refused.
import crypto from "node:crypto";

export type AccessJwk = JsonWebKey & { kid?: string };

export interface AccessConfig {
  team: string;
  aud: string;
  fetchKeys?: () => Promise<{ keys: AccessJwk[] }>;
}

export type AccessResult = { ok: true; email: string } | { ok: false; why: string };

const SKEW_S = 60;
const KEY_MAX_AGE_MS = 60 * 60_000; // refresh hourly; trust last good keys this long
const REFETCH_MIN_GAP_MS = 30_000;

function b64json(part: string): any {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("bad base64url");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export class AccessVerifier {
  private readonly iss: string;
  private readonly fetchKeys: () => Promise<{ keys: AccessJwk[] }>;
  private keys = new Map<string, crypto.KeyObject>();
  private fetchedAt = -Infinity; // last successful fetch
  // Separate throttles: a stale-key refresh and an unknown-kid refetch
  // each run at most once per 30 s, so a rotated key right after a
  // routine fetch is still picked up, and a down endpoint isn't hammered.
  private attemptedAt = { age: -Infinity, kid: -Infinity };
  private inflight: Promise<void> | null = null;

  constructor(private readonly cfg: AccessConfig) {
    if (!/^[a-z0-9-]+$/i.test(cfg.team)) throw new Error("CF_ACCESS_TEAM must be the bare team name");
    if (!cfg.aud) throw new Error("CF_ACCESS_AUD is empty");
    this.iss = `https://${cfg.team}.cloudflareaccess.com`;
    this.fetchKeys = cfg.fetchKeys ?? (async () => {
      const res = await fetch(`${this.iss}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`certs ${res.status}`);
      return (await res.json()) as { keys: AccessJwk[] };
    });
  }

  private async refresh(now: number, reason: "age" | "kid"): Promise<void> {
    if (this.inflight) return this.inflight;
    if (now - this.attemptedAt[reason] < REFETCH_MIN_GAP_MS) return;
    this.attemptedAt[reason] = now;
    this.inflight = (async () => {
      try {
        const { keys } = await this.fetchKeys();
        const next = new Map<string, crypto.KeyObject>();
        for (const jwk of Array.isArray(keys) ? keys : []) {
          if (typeof jwk?.kid !== "string" || jwk.kty !== "RSA") continue;
          try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" })); } catch { /* skip a bad key */ }
        }
        if (next.size === 0) throw new Error("no usable keys");
        this.keys = next;
        this.fetchedAt = now;
      } catch (err) {
        console.error(`[access-jwt] key refresh failed: ${(err as Error).message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async verify(token: string | undefined, now = Date.now()): Promise<AccessResult> {
    try {
      if (typeof token !== "string") return { ok: false, why: "no token" };
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, why: "malformed" };
      const [h, p, s] = parts as [string, string, string];
      const header = b64json(h);
      if (header?.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, why: "bad header" };

      if (now - this.fetchedAt > KEY_MAX_AGE_MS) await this.refresh(now, "age");
      else if (!this.keys.has(header.kid)) await this.refresh(now, "kid");
      if (now - this.fetchedAt > KEY_MAX_AGE_MS) return { ok: false, why: "keys unavailable" };
      const key = this.keys.get(header.kid);
      if (!key) return { ok: false, why: "unknown kid" };

      if (!/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false, why: "malformed" };
      if (!crypto.verify("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return { ok: false, why: "bad signature" };

      const claims = b64json(p);
      const t = Math.floor(now / 1000);
      if (claims?.iss !== this.iss) return { ok: false, why: "bad iss" };
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(this.cfg.aud)) return { ok: false, why: "bad aud" };
      if (typeof claims.exp !== "number" || t > claims.exp + SKEW_S) return { ok: false, why: "expired" };
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || t < claims.nbf - SKEW_S)) return { ok: false, why: "not yet valid" };
      if (typeof claims.email !== "string" || claims.email.trim() === "") return { ok: false, why: "no email" };
      return { ok: true, email: claims.email.trim().toLowerCase() };
    } catch {
      return { ok: false, why: "malformed" };
    }
  }
}
