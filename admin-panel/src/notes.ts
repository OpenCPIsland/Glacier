// Staff notes on a player (admin.db). Staff-only: they never reach a game
// service. Deleting hides a note but keeps it, with who deleted it.
import { ROLE_RANK } from "../shared/permissions.ts";
import type { Store, StaffRow } from "./store.ts";

export const NOTE_MAX = 1000;

export interface Note {
  id: number; swid: string; author: string; body: string; at: number;
  deletedAt: number | null; deletedBy: string | null;
}

const fromRow = (r: any): Note => ({ id: r.id, swid: r.swid, author: r.author, body: r.body, at: r.at, deletedAt: r.deleted_at, deletedBy: r.deleted_by });

export function addNote(store: Store, swid: string, author: string, body: string): number {
  const text = body.trim();
  if (text.length < 1 || text.length > NOTE_MAX) throw new RangeError(`a note is 1-${NOTE_MAX} characters`);
  return Number(store.db.query("INSERT INTO player_notes (swid, author, body, at) VALUES (?, ?, ?, ?)").run(swid, author, text, Date.now()).lastInsertRowid);
}

export function listNotes(store: Store, swid: string, includeDeleted: boolean): Note[] {
  return (store.db.query(`SELECT * FROM player_notes WHERE swid = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY id DESC LIMIT 200`)
    .all(swid) as any[]).map(fromRow);
}

/** Authors delete their own notes; admin and owner delete any. The note must belong to `swid`: the URL's player is what gets audited. */
export function deleteNote(store: Store, swid: string, id: number, by: StaffRow): "deleted" | "not yours" | "none" {
  const row = store.db.query("SELECT author FROM player_notes WHERE id = ? AND swid = ? AND deleted_at IS NULL").get(id, swid) as { author: string } | null;
  if (!row) return "none";
  if (row.author !== by.email && ROLE_RANK[by.role] < ROLE_RANK.admin) return "not yours";
  store.db.query("UPDATE player_notes SET deleted_at = ?, deleted_by = ? WHERE id = ?").run(Date.now(), by.email, id);
  return "deleted";
}
