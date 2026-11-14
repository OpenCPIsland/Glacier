// Cloudflare Access JWT verification with a local key pair standing in for
// the team's certs endpoint.
import crypto from "node:crypto";
import { makeChecker } from "../../tools/lib/harness.ts";
import { AccessVerifier } from "../src/access-jwt.ts";

const { check, finish } = makeChecker();
const TEAM = "iceberg-test", AUD = "aud-tag-123";
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const NOW = 1_800_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);

function keyPair(kid: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid, alg: "RS256", use: "sig" } };
}
const k1 = keyPair("k1");
const k2 = keyPair("k2");
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function token(over: Record<string, unknown> = {}, opts: { kid?: string; alg?: string; key?: crypto.KeyObject } = {}): string {
  const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = b64({ aud: [AUD], iss: ISS, email: "Alice@Example.com", iat: sec(NOW), nbf: sec(NOW), exp: sec(NOW) + 3600, sub: "u1", ...over });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), opts.key ?? k1.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

let fetches = 0;
let keys: JsonWebKey[] = [k1.jwk];
let failFetch = false;
const verifier = () => new AccessVerifier({
  team: TEAM, aud: AUD,
  fetchKeys: async () => { fetches++; if (failFetch) throw new Error("down"); return { keys }; },
});

{
  const v = verifier();
  const r = await v.verify(token(), NOW);
  check(r.ok && r.email === "alice@example.com", "good token → lower-cased email");
  check((await v.verify(token({ aud: "aud-tag-123" }), NOW)).ok, "aud as a string is accepted");
  check(!(await v.verify(token({ aud: ["other"] }), NOW)).ok, "wrong aud is rejected");
  check(!(await v.verify(token({ iss: "https://evil.cloudflareaccess.com" }), NOW)).ok, "wrong iss is rejected");
  check(!(await v.verify(token({ exp: sec(NOW) - 61 }), NOW)).ok, "expired by 61 s is rejected");
  check((await v.verify(token({ exp: sec(NOW) - 59 }), NOW)).ok, "expired by 59 s passes (skew)");
  check(!(await v.verify(token({ nbf: sec(NOW) + 61 }), NOW)).ok, "nbf 61 s ahead is rejected");
  check(!(await v.verify(token({ email: "" }), NOW)).ok && !(await v.verify(token({ email: 5 }), NOW)).ok, "missing or non-string email is rejected");
  const [h, , s] = token().split(".");
  check(!(await v.verify(`${h}.${b64({ aud: [AUD], iss: ISS, email: "owner@x.com", exp: sec(NOW) + 3600 })}.${s}`, NOW)).ok, "tampered payload is rejected");
  check(!(await v.verify(`${b64({ alg: "none", kid: "k1" })}.${token().split(".")[1]}.`, NOW)).ok, "alg none is rejected");
  check(!(await v.verify(token({}, { alg: "HS256" }), NOW)).ok, "alg HS256 is rejected");
  check(!(await v.verify(token({}, { key: k2.privateKey }), NOW)).ok, "signature by a key not in the set is rejected");
  for (const bad of [undefined, "", "a.b", "x.y.z", "!!!.@@@.###", "a.b.c.d"]) {
    let threw = false, r: any;
    try { r = await v.verify(bad, NOW); } catch { threw = true; }
    check(!threw && r && r.ok === false, `malformed token ${JSON.stringify(bad)} → ok:false without throwing`);
  }
}
{
  // Unknown kid: one refetch; a second unknown kid within 30 s doesn't refetch.
  keys = [k1.jwk]; fetches = 0;
  const v = verifier();
  await v.verify(token(), NOW);
  const before = fetches;
  check(!(await v.verify(token({}, { kid: "k2", key: k2.privateKey }), NOW + 1000)).ok, "unknown kid missing from refetch is rejected");
  check(fetches === before + 1, "unknown kid triggers one refetch");
  await v.verify(token({}, { kid: "k3", key: k2.privateKey }), NOW + 2000);
  check(fetches === before + 1, "no second refetch within 30 s");
  keys = [k1.jwk, k2.jwk];
  check((await v.verify(token({}, { kid: "k2", key: k2.privateKey }), NOW + 31_000)).ok, "rotated key is picked up by a later refetch");
}
{
  // Keys older than an hour are refreshed.
  keys = [k1.jwk]; fetches = 0; failFetch = false;
  const v = verifier();
  await v.verify(token(), NOW);
  await v.verify(token({ exp: sec(NOW) + 7200 }), NOW + 61 * 60_000);
  check(fetches === 2, "keys older than 1 h are refetched");
}
{
  // Grace: refresh fails → last good keys for up to 1 h after their fetch.
  keys = [k1.jwk]; failFetch = false;
  const v = verifier();
  check((await v.verify(token(), NOW)).ok, "grace: first fetch works");
  failFetch = true;
  const exp = sec(NOW) + 7200;
  const at59 = await v.verify(token({ exp }), NOW + 59 * 60_000);
  check(at59.ok, "grace: still accepted at 59 min with fetch failing");
  const at61 = await v.verify(token({ exp }), NOW + 61 * 60_000);
  check(!at61.ok && at61.why === "keys unavailable", "grace: refused at 61 min with 'keys unavailable'");
  failFetch = false;
}
{
  // No keys at all (first fetch fails) → refused, no throw.
  failFetch = true;
  const r = await verifier().verify(token(), NOW);
  check(!r.ok && r.why === "keys unavailable", "first fetch failing → keys unavailable");
  failFetch = false;
}

finish();
