// admin.db: staff rows (case-insensitive emails, config owners) and the
// hash-chained audit log.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker } from "../../tools/lib/harness.ts";
import { openStore } from "../src/store.ts";
import { appendAudit, queryAudit, verifyChain, type AuditEntry } from "../src/audit.ts";

const { check, finish } = makeChecker();
const dir = mkdtempSync(join(tmpdir(), "admin-store-"));
const path = join(dir, "admin.db");
const OWNERS = ["boss@x.com"];
const store = openStore(path, OWNERS);

const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  actor: "boss@x.com", role: "owner", action: "staff.edit", target: "a@x.com", params: { b: 2, a: 1 }, reason: null, result: "ok", detail: null, ...over,
});

// Staff
store.upsertStaff("boss@x.com", { email: "Alice@X.com", role: "admin", extras: [], linkedSwid: null });
const t = store.getStaff("alice@x.com");
check(t !== null && t.email === "alice@x.com" && t.role === "admin" && !t.disabled && !t.isConfigOwner, "email stored and found lower-cased");
check(store.getStaff("ALICE@x.COM")?.email === "alice@x.com", "lookup ignores case");
store.upsertStaff("boss@x.com", { email: "alice@x.com", role: "moderator", extras: ["audit.view"], linkedSwid: "{s1}" });
const t2 = store.getStaff("alice@x.com")!;
check(t2.role === "moderator" && t2.extras.join() === "audit.view" && t2.linkedSwid === "{s1}" && store.listStaff().filter((s) => s.email === "alice@x.com").length === 1, "upsert updates the one row");
check(throws(() => store.upsertStaff("boss@x.com", { email: "x@x.com", role: "admin", extras: ["nope.unknown"], linkedSwid: null })), "unknown extra throws");
check(throws(() => store.upsertStaff("boss@x.com", { email: "x@x.com", role: "player" as any, extras: [], linkedSwid: null })), "unknown role throws");
check(throws(() => store.upsertStaff("boss@x.com", { email: "not-an-email", role: "admin", extras: [], linkedSwid: null })), "invalid email throws");
store.setDisabled("boss@x.com", "alice@x.com", true);
check(store.getStaff("alice@x.com")!.disabled === true, "setDisabled disables");
const boss = store.getStaff("Boss@X.com");
check(boss !== null && boss.role === "owner" && !boss.disabled && boss.isConfigOwner, "PANEL_OWNERS email is an enabled owner with no row");
check(throws(() => store.setDisabled("boss@x.com", "boss@x.com", true)), "can't disable a config owner");
check(store.listStaff().some((s) => s.email === "boss@x.com" && s.isConfigOwner), "config owners appear in listStaff");
check(store.getStaff("nobody@x.com") === null, "unknown email → null");

// Removing an email from PANEL_OWNERS removes its access, even after its
// row was saved (e.g. to link a game account).
store.upsertStaff("boss@x.com", { email: "boss@x.com", role: "owner", extras: [], linkedSwid: "{boss}" });
check(store.getStaff("boss@x.com")?.linkedSwid === "{boss}" && store.getStaff("boss@x.com")?.role === "owner", "a config owner's row keeps its link");
const later = openStore(path, ["someone-else@x.com"]);
const gone = later.getStaff("boss@x.com");
check(gone !== null && gone.disabled && !gone.isConfigOwner, `a former PANEL_OWNERS row is disabled (${JSON.stringify(gone)})`);
check(later.getStaff("alice@x.com")?.role === "moderator", "ordinary rows are unaffected");
store.upsertStaff("boss@x.com", { email: "added-owner@x.com", role: "owner", extras: [], linkedSwid: null });
check(later.getStaff("added-owner@x.com")?.disabled === false, "an owner added on the Staff page stays enabled");

// Audit chain
const id1 = appendAudit(store, entry());
appendAudit(store, entry({ result: "denied", actor: "alice@x.com", role: "moderator" }));
appendAudit(store, entry({ target: "evil‮txt" }));
let v = verifyChain(store);
check(v.ok && v.count === 3 && id1 === 1, "3 rows chain verifies");

// Two handles on the same file appending in turn (Review Focus 5)
const other = openStore(path, OWNERS);
for (let i = 0; i < 10; i++) {
  appendAudit(i % 2 ? store : other, entry({ detail: `n${i}` }));
}
v = verifyChain(store);
check(v.ok && v.count === 13, "interleaved appends from two handles keep the chain intact");

check(queryAudit(store, { actor: "alice@x.com", limit: 50 }).length === 1, "filter by actor");
check(queryAudit(store, { result: "denied", limit: 50 }).every((r) => r.result === "denied"), "filter by result");
const page = queryAudit(store, { limit: 5 });
check(page.length === 5 && page[0]!.id === 13 && page[4]!.id === 9, "newest first, limited");
check(queryAudit(store, { before: 9, limit: 5 })[0]!.id === 8, "before paginates");
check(JSON.stringify(queryAudit(store, { limit: 50 }).find((r) => r.id === 1)!.params) === '{"a":1,"b":2}' || queryAudit(store, { limit: 50 }).find((r) => r.id === 1)!.params.a === 1, "params round-trip");

// Every append is anchored outside the DB (journald via stdout), and
// verify reports the head, so a rewritten or cut-off chain can be caught
// by comparing the two.
const lines: string[] = [];
const id14 = appendAudit(store, entry({ detail: "anchored" }), Date.now(), (l) => lines.push(l));
const row14 = store.db.query("SELECT hash FROM audit WHERE id = ?").get(id14) as { hash: string };
check(lines.length === 1 && lines[0] === `[AUDIT] #${id14} ${row14.hash}`, "append logs the new row's id and hash");
v = verifyChain(store);
check(v.ok && v.count === 14 && v.head?.id === id14 && v.head?.hash === row14.hash, "verify returns the head id and hash");
store.db.run("DELETE FROM audit WHERE id = 14");
v = verifyChain(store);
check(v.ok && v.head?.id === 13, "a cut-off tail still verifies, but its head no longer matches the last logged one");

// Tamper
const raw = new Database(path);
raw.run("UPDATE audit SET reason = 'x' WHERE id = 2");
raw.close();
v = verifyChain(store);
check(!v.ok && v.brokenAt === 2, "an edited row is reported at its id");

const raw2 = new Database(path);
raw2.run("UPDATE audit SET reason = NULL WHERE id = 2");
v = verifyChain(store);
check(v.ok && v.count === 13, "after restoring the row, a second verify starts from the first row again");
raw2.run("DELETE FROM audit WHERE id = 5");
raw2.close();
v = verifyChain(store);
check(!v.ok && v.brokenAt === 6, "a deleted row breaks the chain at the next id");

finish();
