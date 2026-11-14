// Escaping, security headers, CSRF tokens and the per-staff rate limiter.
import { makeChecker } from "../../tools/lib/harness.ts";
import { html, SafeHtml, playerText, securityHeaders, csrfToken, checkCsrf, RateLimiter } from "../src/web.ts";

const { check, finish } = makeChecker();
const KEY = "k".repeat(64);
const HOST = "admin.example.com";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

// Escaping
check(html`<p>${"<script>"}</p>`.toString() === "<p>&lt;script&gt;</p>", "interpolated text is escaped");
check(html`<a title="${`"x' & y`}">`.toString() === `<a title="&quot;x&#39; &amp; y">`, "quotes and ampersands are escaped");
const inner = html`<b>${"<i>"}</b>`;
check(html`<p>${inner}</p>`.toString() === "<p><b>&lt;i&gt;</b></p>", "nested html isn't double-escaped");
check(html`<ul>${["<a>", html`<li>ok</li>`]}</ul>`.toString() === "<ul>&lt;a&gt;<li>ok</li></ul>", "arrays are joined, each item escaped unless safe");
check(html`${null}${undefined}${0}${false}`.toString() === "0false", "null/undefined render empty");
check(html`${{ toString: () => "<x>" }}`.toString() === "&lt;x&gt;", "objects are stringified then escaped");
check(!(("<b>" as unknown) instanceof SafeHtml), "plain strings are not SafeHtml");
const bidi = playerText("a‮b<c>").toString();
check(bidi === "a\\u{202e}b&lt;c&gt;", "playerText shows bidi overrides as text and escapes HTML");
check(playerText("x\u001b[31my\r").toString() === "x\\x1b[31my\\x0d", "playerText shows control characters as \\xNN");
check(playerText("zw​j").toString() === "zw\\u{200b}j", "playerText shows zero-width characters");
check(playerText(undefined).toString() === "", "playerText of undefined is empty");

// Headers
const h = securityHeaders();
check(h["Content-Security-Policy"] === "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'", "CSP matches the spec");
check(h["X-Content-Type-Options"] === "nosniff" && h["Referrer-Policy"] === "same-origin", "nosniff, and Referrer-Policy same-origin (no-referrer makes browsers send Origin: null on same-origin POSTs, which the CSRF check refuses)");

// CSRF
const tok = csrfToken(KEY, "a@x.com", NOW);
check(checkCsrf(KEY, "a@x.com", tok, `https://${HOST}`, HOST, NOW), "current token + right origin is accepted");
check(checkCsrf(KEY, "a@x.com", csrfToken(KEY, "a@x.com", NOW - HOUR), `https://${HOST}`, HOST, NOW), "previous hour's token is accepted");
check(!checkCsrf(KEY, "a@x.com", csrfToken(KEY, "a@x.com", NOW - 2 * HOUR), `https://${HOST}`, HOST, NOW), "a token from 2 hours ago is refused");
check(!checkCsrf(KEY, "a@x.com", tok, null, HOST, NOW), "missing origin is refused");
check(!checkCsrf(KEY, "a@x.com", tok, "https://evil", HOST, NOW), "foreign origin is refused");
check(!checkCsrf(KEY, "a@x.com", tok, `http://${HOST}`, HOST, NOW), "http origin is refused");
check(!checkCsrf(KEY, "a@x.com", tok, `https://${HOST}.evil.com`, HOST, NOW), "lookalike origin is refused");
check(!checkCsrf(KEY, "b@x.com", tok, `https://${HOST}`, HOST, NOW), "another staff member's token is refused");
check(!checkCsrf(KEY, "a@x.com", null, `https://${HOST}`, HOST, NOW), "missing token is refused");
check(!checkCsrf(KEY, "a@x.com", "short", `https://${HOST}`, HOST, NOW), "malformed token is refused without throwing");
check(!checkCsrf("other".repeat(13), "a@x.com", tok, `https://${HOST}`, HOST, NOW), "a token made with another key is refused");

// Rate limiter
const rl = new RateLimiter(2);
check(rl.hit("a", NOW) && rl.hit("a", NOW + 1), "allows up to the limit");
check(!rl.hit("a", NOW + 2), "refuses past the limit");
check(rl.hit("b", NOW + 2), "limits are per key");
check(rl.hit("a", NOW + 60_001), "allows again after 60 s");

finish();
