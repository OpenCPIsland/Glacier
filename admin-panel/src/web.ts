// Web primitives: HTML escaping by default, security headers, CSRF tokens
// and a per-staff rate limiter.
import crypto from "node:crypto";

export class SafeHtml {
  constructor(private readonly s: string) {}
  toString(): string { return this.s; }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.toString();
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined) return "";
  return escapeHtml(String(v));
}

/** Tagged template: every interpolation is escaped unless it is SafeHtml from html`` itself. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
  return new SafeHtml(out);
}

/** Text a player chose, with invisible/control characters shown as escapes (plain string; escape it before it goes in HTML). */
export function visible(s: unknown): string {
  return String(s ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => {
    const n = c.codePointAt(0)!;
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u{${n.toString(16)}}`;
  });
}

/** Text a player chose (names, chat, reasons): invisible/control characters shown as escapes, then HTML-escaped. Same rule as tools/mod.ts safe(). */
export function playerText(s: unknown): SafeHtml {
  return new SafeHtml(escapeHtml(visible(s)));
}

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin", // no-referrer would make browsers send Origin: null on our own form POSTs
  };
}

const HOUR_MS = 3_600_000;
const tokenFor = (key: string, email: string, bucket: number) =>
  crypto.createHmac("sha256", key).update(`${email}|${bucket}`).digest("hex");

export function csrfToken(key: string, email: string, now = Date.now()): string {
  return tokenFor(key, email, Math.floor(now / HOUR_MS));
}

export function checkCsrf(key: string, email: string, token: string | null, origin: string | null, host: string, now = Date.now()): boolean {
  if (origin !== `https://${host}`) return false;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;
  const bucket = Math.floor(now / HOUR_MS);
  const given = Buffer.from(token);
  return [bucket, bucket - 1].some((b) => crypto.timingSafeEqual(given, Buffer.from(tokenFor(key, email, b))));
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly perMin: number) {}

  /** Records a hit; false when the key is already at the limit for the last 60 s. */
  hit(key: string, now = Date.now()): boolean {
    if (now - this.lastSweep > WINDOW_MS) {
      for (const [k, ts] of this.hits) if (!ts.length || now - ts[ts.length - 1]! >= WINDOW_MS) this.hits.delete(k);
      this.lastSweep = now;
    }
    const ts = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (ts.length >= this.perMin) { this.hits.set(key, ts); return false; }
    ts.push(now);
    this.hits.set(key, ts);
    return true;
  }
}
