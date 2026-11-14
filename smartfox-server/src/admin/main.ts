// The admin module, loaded by index.ts (the preload shim).
// The supervisor's child inherits BUN_OPTIONS, so this only starts inside
// the game server process itself. It reaches the server's session registry
// through process.cwd() (same module instance the server uses). It must
// never throw.
import { startSignedListener } from "../../../admin-panel/shared/listener.ts";
import { gameRoutes } from "./routes.ts";

export const SECRET_OK = /^[0-9a-f]{64,}$/i.test(process.env.ADMIN_PANEL_SECRET ?? "");
export const IS_GAME_SERVER = /[\\/]handshake-server\.ts$/.test(Bun.main);

try {
  if (IS_GAME_SERVER) {
    if (!SECRET_OK) console.error("[ADMIN] disabled: ADMIN_PANEL_SECRET missing or short");
    else {
      const src = `${process.cwd()}/src`;
      const [registry, mutes, moderation, reply]: any[] = await Promise.all([
        import(`${src}/session-registry.ts`), import(`${src}/mutes.ts`), import(`${src}/commands/moderation.ts`), import(`${src}/commands/reply.ts`),
      ]);
      const routes = gameRoutes({
        getAll: registry.getAll, mutedUntil: mutes.mutedUntil, muteOf: mutes.muteOf, cacheMute: mutes.cacheMute, clearMute: mutes.clearMute,
        disconnectPacket: moderation.disconnectPacket, DISCONNECT_KICK: moderation.DISCONNECT_KICK, systemChatPacket: reply.systemChatPacket,
      });
      startSignedListener("game-server", process.env.ADMIN_PANEL_SECRET!, Number(process.env.SFS_ADMIN_PORT ?? 8092), routes);
      console.log("[ADMIN] game-server module loaded");
    }
  }
} catch (err) {
  console.error(`[ADMIN] game-server module failed to start: ${(err as Error).message}`);
}
