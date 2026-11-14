// The CDN's switch and version list, stored in the settings table.
// Writers validate first (services/cdnManifest.ts validateCdnConfig).
import { getSetting, setSetting } from "../database.ts";
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCdnFiles, clientVersionEquals, isReleaseId, parseCdnConfig, releaseCoversPlatform, validateCdnConfig, type CdnConfig, type ReleaseLoader } from "./cdnManifest.ts";
import { catalogVersion, importReleaseZip, loadRelease, type Release } from "./cdnReleases.ts";

/** Where imported content releases live (services/cdnReleases.ts). */
export const releasesDir = (): string => process.env.CDN_RELEASES_DIR || resolve(import.meta.dir, "../../data/cdn-releases");
export const releaseLoader: ReleaseLoader = (id) => loadRelease(releasesDir(), id);

/** Where the panel leaves uploaded zips for importing (one-time box setup; see docs). */
export const stagingDir = (): string => process.env.CDN_STAGING_DIR || "/var/lib/iceberg-uploads";

/** platforms are row-platform names (lowercase); catalog is set for an Addressables release. */
export interface ReleaseSummary { id: string; bundles: number; platforms: string[]; catalog?: string; importedAt: string }

function summarize(r: Release, importedAt: string): ReleaseSummary {
    const s: ReleaseSummary = { id: r.id, bundles: Object.keys(r.files).length, platforms: Object.keys(r.manifests).sort(), importedAt };
    if (r.platforms) {
        s.platforms = Object.keys(r.platforms).map((p) => p.toLowerCase()).sort();
        s.catalog = [...new Set(Object.values(r.platforms).map((p) => p.catalog))].join(", ");
    }
    return s;
}

/** Imported releases, newest first. */
export function listReleases(): ReleaseSummary[] {
    const dir = releasesDir();
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: ReleaseSummary[] = [];
    for (const name of names) {
        if (name.startsWith(".")) continue;
        const r = loadRelease(dir, name);
        if (!r) continue;
        out.push(summarize(r, statSync(join(dir, name, "release.json")).mtime.toISOString()));
    }
    return out.sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : a.id < b.id ? -1 : 1));
}

const STAGED_NAME = /^[0-9a-f]{32}\.zip$/;

/**
 * Imports a zip the panel left in the staging folder as a release. The staged
 * file is deleted afterwards, whatever the outcome, once it has been found;
 * a bad name or id is refused before touching it so the owner can retry.
 */
export function importStagedRelease(staged: unknown, id: unknown): { status: number; json: unknown } {
    if (typeof staged !== "string" || !STAGED_NAME.test(staged)) return { status: 400, json: { error: "bad staged file name" } };
    if (!isReleaseId(id)) return { status: 400, json: { error: "bad release id (letters, digits, . _ -, up to 40)" } };
    const path = join(stagingDir(), staged);
    let st;
    try { st = lstatSync(path); } catch { return { status: 404, json: { error: "staged file not found" } }; }
    try {
        if (!st.isFile()) return { status: 400, json: { error: "staged file isn't a regular file" } };
        mkdirSync(releasesDir(), { recursive: true });
        const release = importReleaseZip(path, releasesDir(), id);
        return { status: 200, json: { release: summarize(release, new Date().toISOString()) } };
    } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        return { status: /already exists/.test(msg) ? 409 : 400, json: { error: msg } };
    } finally {
        rmSync(path, { force: true });
    }
}

/** validateCdnConfig, plus: every release a row names must be imported and cover the row's platform. */
export function validateCdnConfigWithReleases(v: unknown): ReturnType<typeof validateCdnConfig> {
    const r = validateCdnConfig(v);
    if (!r.ok) return r;
    for (let i = 0; i < r.config.entries.length; i++) {
        const e = r.config.entries[i]!;
        if (!e.release) continue;
        const rel = releaseLoader(e.release);
        if (!rel) return { ok: false, error: `entry ${i + 1}: release ${JSON.stringify(e.release)} not found` };
        const cat = rel.platforms && Object.values(rel.platforms)[0]?.catalog;
        if (cat && !clientVersionEquals(catalogVersion(cat), e.client)) return { ok: false, error: `entry ${i + 1}: release ${JSON.stringify(e.release)} is for client ${catalogVersion(cat)}, not ${e.client}` };
        if (!releaseCoversPlatform(rel, e.platform)) return { ok: false, error: `entry ${i + 1}: release ${JSON.stringify(e.release)} has no content for ${e.platform}` };
    }
    return r;
}

export const CDN_KEY = "cdn_config";
export const HISTORY_KEY = "cdn_directory_history";
const MAX_HISTORY = 20;

/** Missing or invalid means off. */
export function getCdnConfig(): CdnConfig {
    return parseCdnConfig(getSetting(CDN_KEY));
}

interface Published { h2: string; directory: string }

function readHistory(): Published[] {
    try {
        const v = JSON.parse(getSetting(HISTORY_KEY) ?? "[]");
        return Array.isArray(v) ? v.filter((p) => p && typeof p.h2 === "string" && typeof p.directory === "string") : [];
    } catch { return []; }
}

/**
 * Saves the config and remembers its directory body. A client that read the
 * manifest just before a change still asks for the directory it named, and
 * the client caches whatever it gets, so that request must not 404.
 */
export function setCdnConfig(cfg: CdnConfig): void {
    setSetting(CDN_KEY, JSON.stringify(cfg));
    if (cfg.entries.length === 0) return;
    const { h2, directory } = buildCdnFiles(cfg, "", releaseLoader);
    const history = [{ h2, directory }, ...readHistory().filter((p) => p.h2 !== h2)].slice(0, MAX_HISTORY);
    setSetting(HISTORY_KEY, JSON.stringify(history));
}

/** A directory body published earlier, by its hash; null if unknown. */
export function getPublishedDirectory(h2: string): string | null {
    return readHistory().find((p) => p.h2 === h2)?.directory ?? null;
}
