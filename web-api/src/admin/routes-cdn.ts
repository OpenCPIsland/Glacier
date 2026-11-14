// The CDN list for the panel: GET /cdn (cdn.view) and POST /cdn/save
// (cdn.edit, full replacement). The storage functions come in through deps
// so the server's own module instance is used.
import { badRequest as bad, type Route } from "../../../admin-panel/shared/listener.ts";
// Nothing here may import from outside admin/ at run time: on the box this
// folder is a separate copy (deploy-admin.sh). The server's own validator
// comes in through deps, like the storage functions.
import type { CdnConfig } from "../services/cdnManifest.ts";

export interface CdnStore {
  get(): CdnConfig;
  set(c: CdnConfig): void;
  validate(v: unknown): { ok: true; config: CdnConfig } | { ok: false; error: string };
  /** Imported content releases, newest first. */
  listReleases(): unknown[];
  /** Imports a zip the panel staged (by its own random name) as a release; deletes the staged file. */
  importStaged(staged: unknown, id: unknown): { status: number; json: unknown };
}

const oneLine = (s: string, max: number) => s.slice(0, max).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");

export function cdnRoutes(cdn: CdnStore): Record<string, Route> {
  return {
    "/cdn": { method: "GET", action: "cdn.view", run: () => ({ status: 200, json: { config: cdn.get() } }) },
    "/cdn/releases": { method: "GET", action: "cdn.view", run: () => ({ status: 200, json: { releases: cdn.listReleases() } }) },
    "/cdn/releases/import": {
      method: "POST", action: "cdn.edit",
      run(body, actor) {
        if (!body || typeof body !== "object") return bad("body must be an object");
        const r = cdn.importStaged(body.staged, body.id);
        console.log(`[${new Date().toISOString()}] [CDN] release import id=${oneLine(String(body.id), 40)} → ${r.status} by ${oneLine(actor.email, 64)}`);
        return r;
      },
    },
    "/cdn/save": {
      method: "POST", action: "cdn.edit",
      run(body, actor) {
        if (!body || typeof body !== "object") return bad("body must be an object");
        const current = cdn.get();
        const expect = body.expectSetAt ?? null;
        if (expect !== (current.setAt ?? null)) return { status: 409, json: { error: "stale" } };
        const v = cdn.validate({ enabled: body.enabled, entries: body.entries });
        if (!v.ok) return bad(v.error);
        if (body.dryRun === true) return { status: 200, json: { config: v.config } };
        const config: CdnConfig = { ...v.config, setBy: actor.email, setAt: new Date().toISOString() };
        cdn.set(config);
        console.log(`[${new Date().toISOString()}] [CDN] config set enabled=${config.enabled} entries=${config.entries.length} by ${oneLine(actor.email, 64)}`);
        return { status: 200, json: { config } };
      },
    },
  };
}
