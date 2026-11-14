// The one table of panel actions. The panel checks it on every route and
// the web-api / game-server admin modules check it again on every call.
// Anything not listed here is denied.

export type Role = "moderator" | "admin" | "owner";

export const ROLE_RANK: Record<Role, number> = { moderator: 1, admin: 2, owner: 3 };

export interface ActionDef {
  action: string;
  minRole: Role;
  destructive: boolean;
  needsReason: boolean;
}

const def = (action: string, minRole: Role, destructive = false, needsReason = false): [string, ActionDef] =>
  [action, { action, minRole, destructive, needsReason }];

export const ACTIONS: Record<string, ActionDef> = Object.freeze(Object.assign(Object.create(null), Object.fromEntries([
  def("dashboard.view", "moderator"),
  def("audit.view", "admin"),
  def("audit.verify", "admin"),
  def("staff.view", "admin"),
  def("staff.edit", "owner", true),
  def("role.sync", "owner", true),
  // The island client's CDN list: a bad list strands builds, so edits are owner-only.
  def("cdn.view", "admin"),
  def("cdn.edit", "owner", true),
  // Moderation (sub-project 2a). The listeners check these again and
  // also apply the rank rule (shared/rank.ts).
  def("players.view", "moderator"),
  def("player.kick", "moderator", false, true),
  def("player.mute", "moderator", false, true),
  def("player.unmute", "moderator", false, true),
  def("player.warn", "moderator", false, true),
  def("player.ban", "moderator", true, true),
  def("player.ban.permanent", "admin", true, true),
  def("player.unban", "moderator", false, true),
  def("ban.lift.any", "admin"), // not a route: checked inside /ban/lift
  def("reports.view", "moderator"),
  def("reports.resolve", "moderator", false, true),
  def("notes.view", "moderator"),
  def("notes.edit", "moderator"),
  def("filter.view", "admin"),
  def("filter.edit", "admin", true, true),
  def("templates.edit", "admin"),
  // Chat logs (sub-project 2b). Reading is audited by the panel; the
  // retention window is owner-only because shortening it deletes evidence.
  def("chat.view", "moderator"),
  def("chat.retention", "owner", true, true),
])));

// Panel role → players.role in the game. The game has no owner role.
export const IN_GAME_ROLE: Record<Role, "moderator" | "admin"> = { moderator: "moderator", admin: "admin", owner: "admin" };

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && Object.hasOwn(ROLE_RANK, v);
}

export function actionDef(action: string): ActionDef | undefined {
  return Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
}

// Extras grant a listed action regardless of role, but never an
// owner-minimum one.
export function can(role: Role, extras: readonly string[], action: string): boolean {
  const a = actionDef(action);
  if (!a || !isRole(role)) return false;
  if (ROLE_RANK[role] >= ROLE_RANK[a.minRole]) return true;
  return a.minRole !== "owner" && extras.includes(action);
}
