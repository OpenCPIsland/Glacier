// Permissions table: role ordering, extras, owner-only actions, deny by default.
import { makeChecker } from "../../tools/lib/harness.ts";
import { ACTIONS, actionDef, can, isRole, IN_GAME_ROLE, ROLE_RANK, type Role } from "../shared/permissions.ts";
import { actorRank, targetRank, outranks, MOD_BAN_MAX_HOURS, MUTE_MAX_MINUTES } from "../shared/rank.ts";

const { check, finish } = makeChecker();

check(can("moderator", [], "dashboard.view") === true, "moderator can view the dashboard");
check(can("moderator", [], "audit.view") === false, "moderator can't view the audit log");
check(can("moderator", ["audit.view"], "audit.view") === true, "an extra grants audit.view to a moderator");
check(can("admin", ["staff.edit"], "staff.edit") === false, "extras can't grant owner-only actions");
check(can("owner", [], "staff.edit") === true, "owner can edit staff");
check(can("owner", [], "nope.unknown") === false, "unknown action is denied, even for owner");
check(can("owner", ["nope.unknown"], "nope.unknown") === false, "an extra can't create an unknown action");
check(can("admin", [], "toString") === false && can("owner", [], "__proto__") === false, "prototype keys are not actions");
check(IN_GAME_ROLE.owner === "admin" && IN_GAME_ROLE.admin === "admin" && IN_GAME_ROLE.moderator === "moderator", "in-game role mapping");
check(ROLE_RANK.moderator < ROLE_RANK.admin && ROLE_RANK.admin < ROLE_RANK.owner, "role ordering");
check(isRole("admin") && !isRole("player") && !isRole("toString") && !isRole(undefined), "isRole");
const CORE = ["audit.verify", "audit.view", "cdn.edit", "cdn.view", "dashboard.view", "role.sync", "staff.edit", "staff.view"];
// Moderation actions (sub-project 2a): action → [min role, needs reason].
const MOD: Record<string, [Role, boolean]> = {
  "players.view": ["moderator", false], "player.kick": ["moderator", true], "player.mute": ["moderator", true],
  "player.unmute": ["moderator", true], "player.warn": ["moderator", true], "player.ban": ["moderator", true],
  "player.ban.permanent": ["admin", true], "player.unban": ["moderator", true], "ban.lift.any": ["admin", false],
  "reports.view": ["moderator", false], "reports.resolve": ["moderator", true], "notes.view": ["moderator", false],
  "notes.edit": ["moderator", false], "filter.view": ["admin", false], "filter.edit": ["admin", true], "templates.edit": ["admin", false],
  // Chat logs (sub-project 2b).
  "chat.view": ["moderator", false], "chat.retention": ["owner", true],
};
check(Object.keys(ACTIONS).sort().join() === [...CORE, ...Object.keys(MOD)].sort().join(), `exactly the core + moderation actions (${Object.keys(ACTIONS).sort().join()})`);
for (const [action, [minRole, reason]] of Object.entries(MOD)) {
  for (const role of ["moderator", "admin", "owner"] as Role[]) {
    check(can(role, [], action) === (ROLE_RANK[role] >= ROLE_RANK[minRole]), `${role} ${can(role, [], action) ? "can" : "can't"} ${action}`);
  }
  check(actionDef(action)!.needsReason === reason, `${action} ${reason ? "needs" : "doesn't need"} a reason`);
}
check(can("moderator", ["player.ban.permanent"], "player.ban.permanent") === true, "an extra can grant permanent bans to a moderator");
check(ACTIONS["player.ban"]!.destructive && ACTIONS["player.ban.permanent"]!.destructive && ACTIONS["filter.edit"]!.destructive, "bans and filter edits are destructive");

check(!can("admin", ["chat.retention"], "chat.retention") && !can("moderator", ["chat.retention"], "chat.retention") && ACTIONS["chat.retention"]!.destructive, "extras can't grant chat.retention; it is destructive");

check(actorRank("moderator") === 1 && actorRank("admin") === 2 && actorRank("owner") === 3, "actor ranks");
check(targetRank("player") === 0 && targetRank("moderator") === 1 && targetRank("admin") === 2 && targetRank("weird") === 0 && targetRank("toString") === 0, "target ranks, unknown = player");
check(outranks("moderator", "player") && !outranks("moderator", "moderator"), "moderators act on players only");
check(outranks("admin", "moderator") && !outranks("admin", "admin"), "admins act on moderators, not admins");
check(outranks("owner", "admin"), "the owner acts on in-game admins");
check(MOD_BAN_MAX_HOURS === 72 && MUTE_MAX_MINUTES === 10080, "caps");
check(ACTIONS["staff.edit"]!.destructive && ACTIONS["role.sync"]!.destructive && !ACTIONS["dashboard.view"]!.destructive, "destructive flags");
check(can("admin", [], "cdn.view") && !can("moderator", [], "cdn.view") && !can("admin", [], "cdn.edit") && !can("admin", ["cdn.edit"], "cdn.edit") && can("owner", [], "cdn.edit") && ACTIONS["cdn.edit"]!.destructive, "cdn.view is admin, cdn.edit is owner-only and destructive");

finish();
