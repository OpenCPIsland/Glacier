// Reason templates (admin.db): the quick reasons staff pick when they act.
// Seeded once when the table is created; after that they are data, edited
// on the Templates page.
import type { Database } from "bun:sqlite";
import type { Store } from "./store.ts";

export type AppliesTo = "any" | "kick" | "mute" | "warn" | "ban" | "report";
export const APPLIES_TO: readonly AppliesTo[] = ["any", "kick", "mute", "warn", "ban", "report"];
export const LABEL_MAX = 80;
/** Joins a template label and the optional note into one reason. */
export const REASON_SEPARATOR = " — ";

export interface Template { id: number; label: string; appliesTo: AppliesTo; sort: number; disabled: boolean }

export const SEED_TEMPLATES: readonly { label: string; appliesTo: AppliesTo }[] = [
  { label: "Spamming chat", appliesTo: "any" },
  { label: "Swearing or filter bypass", appliesTo: "any" },
  { label: "Harassing a player", appliesTo: "any" },
  { label: "Inappropriate name", appliesTo: "any" },
  { label: "Sharing personal info", appliesTo: "any" },
  { label: "Exploiting a bug", appliesTo: "any" },
  { label: "Asked to be kicked", appliesTo: "kick" },
];

export function createTemplates(db: Database): void {
  const existed = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reason_templates'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS reason_templates (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    applies_to TEXT NOT NULL CHECK (applies_to IN ('any','kick','mute','warn','ban','report')),
    sort INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0
  )`);
  if (existed) return;
  const ins = db.query("INSERT INTO reason_templates (label, applies_to, sort) VALUES (?, ?, ?)");
  SEED_TEMPLATES.forEach((t, i) => ins.run(t.label, t.appliesTo, i));
}

const fromRow = (r: any): Template => ({ id: r.id, label: r.label, appliesTo: r.applies_to, sort: r.sort, disabled: !!r.disabled });

/** Enabled templates for an action (plus "any"), in order; all actions when appliesTo is left out. */
export function listTemplates(store: Store, appliesTo?: AppliesTo, includeDisabled = false): Template[] {
  const where = [includeDisabled ? null : "disabled = 0", appliesTo ? "applies_to IN ('any', ?)" : null].filter(Boolean);
  return (store.db.query(`SELECT * FROM reason_templates ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sort, id`)
    .all(...(appliesTo ? [appliesTo] : [])) as any[]).map(fromRow);
}

export function upsertTemplate(store: Store, t: { id?: number; label: string; appliesTo: AppliesTo; sort: number }): number {
  const label = t.label.trim();
  if (label.length < 1 || label.length > LABEL_MAX) throw new RangeError(`a label is 1-${LABEL_MAX} characters`);
  if (label.includes(REASON_SEPARATOR.trim())) throw new RangeError("a label can't contain —");
  if (!APPLIES_TO.includes(t.appliesTo)) throw new RangeError("unknown action");
  if (!Number.isInteger(t.sort) || t.sort < -1000 || t.sort > 1000) throw new RangeError("sort is -1000..1000");
  if (t.id === undefined) {
    return Number(store.db.query("INSERT INTO reason_templates (label, applies_to, sort) VALUES (?, ?, ?)").run(label, t.appliesTo, t.sort).lastInsertRowid);
  }
  if (store.db.query("UPDATE reason_templates SET label = ?, applies_to = ?, sort = ? WHERE id = ?").run(label, t.appliesTo, t.sort, t.id).changes === 0) {
    throw new RangeError("unknown template");
  }
  return t.id;
}

export function setTemplateDisabled(store: Store, id: number, disabled: boolean): boolean {
  return store.db.query("UPDATE reason_templates SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id).changes > 0;
}
