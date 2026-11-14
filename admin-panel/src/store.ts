// admin.db: the panel's own database (staff list, audit log, staff notes,
// reason templates). Nothing in
// here is shared with the web API's database.
import { Database } from "bun:sqlite";
import { actionDef, isRole, type Role } from "../shared/permissions.ts";
import { createTemplates } from "./templates.ts";

export interface StaffRow {
  email: string;
  role: Role;
  extras: string[];
  linkedSwid: string | null;
  disabled: boolean;
  addedBy: string;
  addedAt: number;
  updatedAt: number;
  isConfigOwner: boolean;
}

export interface Store {
  readonly db: Database;
  getStaff(email: string): StaffRow | null;
  listStaff(): StaffRow[];
  upsertStaff(by: string, row: { email: string; role: Role; extras: string[]; linkedSwid: string | null }): void;
  setDisabled(by: string, email: string, disabled: boolean): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS staff (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  extras TEXT NOT NULL DEFAULT '[]',
  linked_swid TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  params TEXT NOT NULL,
  reason TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor);
CREATE INDEX IF NOT EXISTS audit_action ON audit(action);
CREATE TABLE IF NOT EXISTS player_notes (
  id INTEGER PRIMARY KEY,
  swid TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  deleted_at INTEGER NULL,
  deleted_by TEXT NULL
);
CREATE INDEX IF NOT EXISTS player_notes_swid ON player_notes(swid);
`;

export const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function openStore(path: string, owners: string[]): Store {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  createTemplates(db);
  // Rows saved while their email was in PANEL_OWNERS are marked, so taking
  // the email out of PANEL_OWNERS also takes the access away.
  if (!(db.query("SELECT name FROM pragma_table_info('staff')").all() as { name: string }[]).some((c) => c.name === "config_owner")) {
    db.exec("ALTER TABLE staff ADD COLUMN config_owner INTEGER NOT NULL DEFAULT 0");
  }
  const ownerSet = new Set(owners.map(normEmail).filter(Boolean));

  const fromRow = (r: any): StaffRow => ({
    email: r.email,
    role: r.role,
    extras: JSON.parse(r.extras),
    linkedSwid: r.linked_swid,
    disabled: !!r.disabled || (!!r.config_owner && !ownerSet.has(r.email)),
    addedBy: r.added_by,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
    isConfigOwner: false,
  });
  // PANEL_OWNERS are always enabled owners; a stored row only adds a link.
  const asOwner = (email: string, row: StaffRow | null): StaffRow => ({
    ...(row ?? { email, extras: [], linkedSwid: null, addedBy: "PANEL_OWNERS", addedAt: 0, updatedAt: 0 }),
    email, role: "owner", disabled: false, isConfigOwner: true,
  } as StaffRow);

  const selectOne = db.query("SELECT * FROM staff WHERE email = ?");
  const getStaff = (email: string): StaffRow | null => {
    const e = normEmail(email);
    const r = selectOne.get(e);
    const row = r ? fromRow(r) : null;
    return ownerSet.has(e) ? asOwner(e, row) : row;
  };

  return {
    db,
    getStaff,
    listStaff() {
      const rows = (db.query("SELECT * FROM staff ORDER BY email").all() as any[]).map(fromRow);
      const out = rows.map((r) => (ownerSet.has(r.email) ? asOwner(r.email, r) : r));
      for (const o of ownerSet) if (!rows.some((r) => r.email === o)) out.push(asOwner(o, null));
      return out.sort((a, b) => a.email.localeCompare(b.email));
    },
    upsertStaff(by, row) {
      const email = normEmail(row.email);
      if (!EMAIL.test(email) || email.length > 254) throw new Error("invalid email");
      if (!isRole(row.role)) throw new Error("unknown role");
      for (const x of row.extras) if (!actionDef(x)) throw new Error(`unknown extra ${x}`);
      const now = Date.now();
      db.query(`INSERT INTO staff (email, role, extras, linked_swid, disabled, added_by, added_at, updated_at, config_owner)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET role = excluded.role, extras = excluded.extras,
                  linked_swid = excluded.linked_swid, updated_at = excluded.updated_at,
                  config_owner = MAX(config_owner, excluded.config_owner)`)
        .run(email, row.role, JSON.stringify([...new Set(row.extras)].sort()), row.linkedSwid, normEmail(by), now, now, ownerSet.has(email) ? 1 : 0);
    },
    setDisabled(by, email, disabled) {
      const e = normEmail(email);
      if (ownerSet.has(e)) throw new Error("config owner");
      // Enabling a former PANEL_OWNERS row on purpose makes it an ordinary row.
      const r = disabled
        ? db.query("UPDATE staff SET disabled = 1, updated_at = ? WHERE email = ?").run(Date.now(), e)
        : db.query("UPDATE staff SET disabled = 0, config_owner = 0, updated_at = ? WHERE email = ?").run(Date.now(), e);
      if (r.changes === 0) throw new Error("unknown staff");
    },
  };
}
