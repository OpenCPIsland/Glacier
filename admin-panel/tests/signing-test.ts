// Signed panel → server calls: round trip, replay, staleness, tampering,
// non-loopback peers, wrong secret, and the permission re-check.
import { makeChecker } from "../../tools/lib/harness.ts";
import { signHeaders, verifySigned, NonceCache, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const SECRET = "a".repeat(64);
const owner: Actor = { email: "owner@x.com", role: "owner", extras: [] };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: ["audit.view"] };
const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ swid: "{abc}", role: "moderator" });

const req = (headers: Record<string, string>, over: Partial<{ method: string; path: string; body: string; remoteAddress: string }> = {}) => ({
  method: "POST", path: "/role", body: BODY, remoteAddress: "127.0.0.1", ...over, headers,
});
const sign = (actor = owner, action = "role.sync", now = NOW) => signHeaders(SECRET, "POST", "/role", BODY, actor, action, now);

{
  const nonces = new NonceCache();
  const h = sign();
  const r = verifySigned(SECRET, req(h), nonces, NOW + 1000);
  check(r.ok && r.actor.email === "owner@x.com" && r.actor.role === "owner" && r.action === "role.sync", "valid call is accepted");
  const again = verifySigned(SECRET, req(h), nonces, NOW + 2000);
  check(!again.ok && again.status === 401, "replayed nonce is rejected");
}
{
  const r = verifySigned(SECRET, req(sign()), new NonceCache(), NOW + 31_000);
  check(!r.ok && r.status === 401, "a call 31 s old is rejected");
  const early = verifySigned(SECRET, req(sign()), new NonceCache(), NOW - 31_000);
  check(!early.ok, "a call 31 s in the future is rejected");
  const edge = verifySigned(SECRET, req(sign()), new NonceCache(), NOW + 29_000);
  check(edge.ok, "a call 29 s old is accepted");
}
{
  const r = verifySigned(SECRET, req(sign(), { body: BODY.replace("moderator", "moderatoR") }), new NonceCache(), NOW);
  check(!r.ok && r.status === 401, "a changed body byte is rejected");
}
check(!verifySigned(SECRET, req(sign(), { path: "/player/resolve" }), new NonceCache(), NOW).ok, "a different path is rejected");
check(!verifySigned(SECRET, req(sign(), { method: "GET" }), new NonceCache(), NOW).ok, "a different method is rejected");
{
  const h = sign(mod, "dashboard.view");
  check(!verifySigned(SECRET, req({ ...h, "X-Admin-Role": "owner" }), new NonceCache(), NOW).ok, "role raised to owner is rejected");
  check(!verifySigned(SECRET, req({ ...h, "X-Admin-Extras": "audit.view,staff.view" }), new NonceCache(), NOW).ok, "changed extras are rejected");
  check(!verifySigned(SECRET, req({ ...h, "X-Admin-Action": "audit.view" }), new NonceCache(), NOW).ok, "changed action is rejected");
  check(!verifySigned(SECRET, req({ ...h, "X-Admin-Actor": "owner@x.com" }), new NonceCache(), NOW).ok, "changed actor is rejected");
}
{
  const r = verifySigned(SECRET, req(sign(), { remoteAddress: "10.0.0.5" }), new NonceCache(), NOW);
  check(!r.ok && r.status === 403, "a non-loopback peer is refused (403)");
  check(verifySigned(SECRET, req(sign(), { remoteAddress: "::ffff:127.0.0.1" }), new NonceCache(), NOW).ok, "IPv4-mapped loopback is accepted");
  check(!verifySigned(SECRET, req(sign(), { remoteAddress: undefined as unknown as string }), new NonceCache(), NOW).ok, "an unknown peer is refused");
}
check(!verifySigned("b".repeat(64), req(sign()), new NonceCache(), NOW).ok, "the wrong secret is rejected");
{
  const r = verifySigned(SECRET, req(sign(mod, "staff.edit")), new NonceCache(), NOW);
  check(!r.ok && r.status === 403, "a moderator signing staff.edit is refused (403)");
  const ok = verifySigned(SECRET, req(sign(mod, "audit.view")), new NonceCache(), NOW);
  check(ok.ok && ok.ok && ok.actor.extras.join() === "audit.view", "a moderator with the audit.view extra is accepted");
}
{
  const h = sign();
  const missing = { ...h } as Record<string, string>;
  delete missing["X-Admin-Sig"];
  check(!verifySigned(SECRET, req(missing), new NonceCache(), NOW).ok, "a missing signature is rejected");
  check(!verifySigned(SECRET, req({ ...h, "X-Admin-Sig": "zz" }), new NonceCache(), NOW).ok, "a short signature is rejected without throwing");
  check(!verifySigned(SECRET, req({ ...h, "X-Admin-Ts": "abc" }), new NonceCache(), NOW).ok, "a non-numeric timestamp is rejected");
}
{
  // Header names arrive lower-cased from node:http.
  const lower = Object.fromEntries(Object.entries(sign()).map(([k, v]) => [k.toLowerCase(), v]));
  check(verifySigned(SECRET, req(lower), new NonceCache(), NOW).ok, "lower-case header names are accepted");
}
{
  const n = new NonceCache();
  check(n.seen("x", NOW) === false && n.seen("x", NOW + 1) === true, "nonce cache remembers a nonce");
  check(n.seen("x", NOW + 61_000) === false, "nonce cache forgets after 60 s");
}
check(signHeaders(SECRET, "POST", "/x", "", { email: "a@x.com", role: "admin", extras: ["b", "a"] }, "audit.view", NOW)["X-Admin-Extras"] === "a,b", "extras are sent sorted");

finish();
