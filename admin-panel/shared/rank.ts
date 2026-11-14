// The rank rule both admin listeners apply: staff act only on players whose
// game role is below their own panel rank. Panel ranks: moderator 1,
// admin 2, owner 3. Game roles: player 0, moderator 1, admin 2. Anything
// else counts as a player.
import { ROLE_RANK, type Role } from "./permissions.ts";

const GAME_RANK: Record<string, 0 | 1 | 2> = Object.assign(Object.create(null), { player: 0, moderator: 1, admin: 2 });

export const MOD_BAN_MAX_HOURS = 72;
export const MUTE_MAX_MINUTES = 10080; // 7 days

export const actorRank = (role: Role): 1 | 2 | 3 => ROLE_RANK[role] as 1 | 2 | 3;

export function targetRank(gameRole: string): 0 | 1 | 2 {
  return Object.hasOwn(GAME_RANK, gameRole) ? GAME_RANK[gameRole]! : 0;
}

export function outranks(actor: Role, targetGameRole: string): boolean {
  return actorRank(actor) > targetRank(targetGameRole);
}
