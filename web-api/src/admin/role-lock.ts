// Role lock for panel-managed staff accounts, as a trigger in the game
// database: a locked account's players.role can only be set to the role
// in its lock row. lockedSetRole moves the lock and the role together, so
// it is the only way to change a locked role. Every other writer (the
// in-game :promote / :demote through /api/internal/set-role) is aborted.
// The lock is in the DB file, so it holds across restarts.
import type { Database } from "bun:sqlite";

export type GameRole = "player" | "moderator" | "admin";

export function installRoleLock(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_role_locks (username TEXT PRIMARY KEY, role TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS admin_role_lock BEFORE UPDATE OF role ON players
    WHEN EXISTS (SELECT 1 FROM admin_role_locks l WHERE l.username = NEW.username AND l.role IS NOT NEW.role)
    BEGIN SELECT RAISE(ABORT, 'role managed by admin panel'); END;
  `);
}

/** Sets the role and its lock in one transaction. False when no player has that exact username. */
export function lockedSetRole(db: Database, username: string, role: GameRole): boolean {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM players WHERE username = ?").get(username)) return false;
    db.query("INSERT INTO admin_role_locks (username, role) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET role = excluded.role").run(username, role);
    db.query("UPDATE players SET role = ? WHERE username = ?").run(role, username);
    return true;
  }).immediate();
}

export function unlockRole(db: Database, username: string): void {
  db.query("DELETE FROM admin_role_locks WHERE username = ?").run(username);
}

export function uninstallRoleLock(db: Database): void {
  db.exec("DROP TRIGGER IF EXISTS admin_role_lock; DROP TABLE IF EXISTS admin_role_locks;");
}
