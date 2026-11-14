// Append-only, hash-chained audit log. Each row's hash covers the row and
// the previous row's hash, so editing or deleting a row breaks the chain
// at that point. There is deliberately no update or delete function here.
// Limitation: removing the newest rows leaves a valid shorter chain; the
// chain proves rows weren't altered, not that none were cut off the end.
import crypto from "node:crypto";
import type { Store } from "./store.ts";

export interface AuditEntry {
  actor: string;
  role: string;
  action: string;
  target: string | null;
  params: unknown;
  reason: string | null;
  result: "ok" | "denied" | "error" | "unreachable";
  detail: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  at: number;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function rowHash(prevHash: string, r: { id: number; at: number; actor: string; role: string; action: string; target: string | null; params: string; reason: string | null; result: string; detail: string | null }): string {
  const { id, at, actor, role, action, target, params, reason, result, detail } = r;
  return crypto.createHash("sha256").update(prevHash + canonicalJson({ id, at, actor, role, action, target, params, reason, result, detail })).digest("hex");
}

// Each new row's id and hash also goes to stdout, i.e. the journal, which
// the panel's user can't edit. The chain has no key, so someone who can
// write admin.db could rewrite it and recompute every hash, or cut rows
// off the end; the journal's last "[AUDIT] #id hash" line catches both
// (compare it with the head the Verify button shows).
export function appendAudit(store: Store, e: AuditEntry, now = Date.now(), log: (line: string) => void = console.log): number {
  const id = appendRow(store, e, now);
  const { hash } = store.db.query("SELECT hash FROM audit WHERE id = ?").get(id) as { hash: string };
  log(`[AUDIT] #${id} ${hash}`);
  return id;
}

function appendRow(store: Store, e: AuditEntry, now: number): number {
  const params = canonicalJson(e.params ?? null);
  // IMMEDIATE takes the write lock before reading the tail, so two writers
  // can't both chain onto the same previous row.
  return store.db.transaction(() => {
    const last = store.db.query("SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string } | null;
    const id = (last?.id ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const row = { id, at: now, actor: e.actor, role: e.role, action: e.action, target: e.target, params, reason: e.reason, result: e.result, detail: e.detail };
    const hash = rowHash(prevHash, row);
    store.db.query(`INSERT INTO audit (id, at, actor, role, action, target, params, reason, result, detail, prev_hash, hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, now, e.actor, e.role, e.action, e.target, params, e.reason, e.result, e.detail, prevHash, hash);
    return id;
  }).immediate();
}

const toRow = (r: any): AuditRow => ({
  id: r.id, at: r.at, actor: r.actor, role: r.role, action: r.action, target: r.target,
  params: JSON.parse(r.params), reason: r.reason, result: r.result, detail: r.detail, prevHash: r.prev_hash, hash: r.hash,
});

export interface AuditFilter {
  actor?: string;
  action?: string;
  target?: string;
  result?: string;
  from?: number;
  to?: number;
  before?: number;
  limit: number;
}

export function queryAudit(store: Store, f: AuditFilter): AuditRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, v: string | number | undefined) => { if (v !== undefined && v !== "") { where.push(sql); args.push(v); } };
  add("actor = ?", f.actor);
  add("action = ?", f.action);
  add("target = ?", f.target);
  add("result = ?", f.result);
  add("at >= ?", f.from);
  add("at < ?", f.to);
  add("id < ?", f.before);
  const limit = Math.max(1, Math.min(500, Math.floor(f.limit)));
  const sql = `SELECT * FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`;
  return (store.db.query(sql).all(...args) as any[]).map(toRow);
}

export function verifyChain(store: Store): { ok: true; count: number; head: { id: number; hash: string } | null } | { ok: false; brokenAt: number } {
  // A fresh statement, always finalized: db.query() caches statements, and
  // returning early from a cached one's iterate() left it mid-way, so the
  // next verify started from the wrong row.
  const stmt = store.db.prepare("SELECT * FROM audit ORDER BY id");
  try {
    let prev = GENESIS;
    let count = 0;
    let head: { id: number; hash: string } | null = null;
    for (const r of stmt.iterate() as Iterable<any>) {
      if (r.prev_hash !== prev || rowHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.id };
      prev = r.hash;
      head = { id: r.id, hash: r.hash };
      count++;
    }
    return { ok: true, count, head };
  } finally {
    stmt.finalize();
  }
}
