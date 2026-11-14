/**
 * The island client's CDN boot files, built from an admin-set list of
 * client builds (docs: the client reads CPipeManifestService and
 * InitializeManifestDefinitionCommand):
 *
 * - mapping  /__mapping_cpremix_prod.json: {"default":{"n":<manifest path>,"v":<int>}}
 * - manifest /manifests/cpipe.<H1>.json: cdnRoot plus one path,
 *   ClientManifestDirectory.json, with its CRC and version (H2)
 * - directory /cdn.disney.io/<H2>/ClientManifestDirectory.json: one
 *   ContentManifestDirectoryEntry per build, all "embedded"
 *
 * Names are hashes of the exact bodies, so a changed list is a new file
 * name and the client's on-disk caches (keyed by those names) can't keep a
 * stale copy. Nothing here touches the database.
 */
import { createHash } from "node:crypto";

export const CDN_PLATFORMS = ["standalonewindows64", "standaloneosx", "standalonelinux64", "android", "ios", "webgl"] as const;
export type CdnPlatform = (typeof CDN_PLATFORMS)[number];
export const MAX_CDN_ENTRIES = 200;

/** An optional content release (services/cdnReleases.ts): the row's players download its bundles instead of using embedded content. */
export interface CdnEntry { client: string; platform: CdnPlatform; contentVersion: string; release?: string }

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const isReleaseId = (s: unknown): s is string => typeof s === "string" && RELEASE_ID.test(s);

/** What buildCdnFiles needs to know about a release; see Release in cdnReleases.ts. */
export interface ReleaseInfo { id: string; files: Record<string, { crc?: string; sha256?: string; size?: number }>; manifests: Record<string, string>; platforms?: Record<string, { catalog: string; hash: string }> }
export type ReleaseLoader = (id: string) => ReleaseInfo | null;
export interface CdnConfig { enabled: boolean; entries: CdnEntry[]; setBy?: string; setAt?: string }

export const OFF: CdnConfig = Object.freeze({ enabled: false, entries: Object.freeze([]) as unknown as CdnEntry[] });

const CLIENT = /^\d{1,6}(\.\d{1,6}){1,3}$/;
const CONTENT_VERSION = /^[0-9a-f]{40}$/;

/** The client's ClientInfo.ParseClientVersion + System.Version: 2 to 4 int components. Null when invalid. */
function parseVersion(s: string): number[] | null {
    const parts = s.replace(/v/g, "").split(".");
    if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^\d+$/.test(p))) return null;
    return parts.map(Number);
}

/** System.Version.Equals: an unset component is -1, so 1.15 ≠ 1.15.0, while 1.015.0 = 1.15.0. */
export function clientVersionEquals(a: string, b: string): boolean {
    const x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) return false;
    for (let i = 0; i < 4; i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return false;
    return true;
}

/** CPipeManifestService.getFullAssetUrl without the access token. */
export function fullAssetUrl(cdnRoot: string, v: string, asset: string): string {
    let root = cdnRoot.replace(/\/+$/, "");
    if (!root.endsWith(".disney.io")) root += ".disney.io";
    return `${root}/${v}/${asset}`;
}

const q = (v: unknown) => JSON.stringify(String(v).slice(0, 40));
const byEntry = (a: CdnEntry, b: CdnEntry) => (a.client < b.client ? -1 : a.client > b.client ? 1 : a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0);

export function validateCdnConfig(v: unknown): { ok: true; config: CdnConfig } | { ok: false; error: string } {
    const fail = (error: string) => ({ ok: false as const, error });
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail("config must be an object");
    const o = v as Record<string, unknown>;
    if (typeof o.enabled !== "boolean") return fail("enabled must be true or false");
    if (!Array.isArray(o.entries)) return fail("entries must be a list");
    if (o.entries.length > MAX_CDN_ENTRIES) return fail(`too many entries (max ${MAX_CDN_ENTRIES})`);
    const seen = new Set<string>();
    const entries: CdnEntry[] = [];
    for (let i = 0; i < o.entries.length; i++) {
        const e = o.entries[i] as Record<string, unknown> | null;
        const at = `entry ${i + 1}`;
        if (!e || typeof e !== "object" || Array.isArray(e)) return fail(`${at}: not an object`);
        if (typeof e.client !== "string" || !CLIENT.test(e.client)) return fail(`${at}: bad client ${q(e.client)}`);
        if (typeof e.platform !== "string" || !(CDN_PLATFORMS as readonly string[]).includes(e.platform)) return fail(`${at}: bad platform ${q(e.platform)}`);
        if (typeof e.contentVersion !== "string" || !CONTENT_VERSION.test(e.contentVersion)) return fail(`${at}: bad contentVersion ${q(e.contentVersion)}`);
        const key = `${parseVersion(e.client)!.join(".")}|${e.platform}`;
        if (seen.has(key)) return fail(`${at}: duplicate ${e.client} ${e.platform}`);
        seen.add(key);
        const entry: CdnEntry = { client: e.client, platform: e.platform as CdnPlatform, contentVersion: e.contentVersion };
        if (e.release !== undefined) {
            if (!isReleaseId(e.release)) return fail(`${at}: bad release ${q(e.release)}`);
            entry.release = e.release;
        }
        entries.push(entry);
    }
    if (o.enabled && entries.length === 0) return fail("can't turn on with an empty list");
    entries.sort(byEntry);
    const config: CdnConfig = { enabled: o.enabled, entries };
    if (typeof o.setBy === "string") config.setBy = o.setBy;
    if (typeof o.setAt === "string") config.setAt = o.setAt;
    return { ok: true, config };
}

/** The stored value, or OFF for anything missing or invalid. Never throws. */
export function parseCdnConfig(raw: string | null): CdnConfig {
    try {
        if (!raw) return OFF;
        const r = validateCdnConfig(JSON.parse(raw));
        return r.ok ? r.config : OFF;
    } catch { return OFF; }
}

/** The mapping's `v`: the publish time in Unix seconds, always a positive int32 (the client casts it to int). */
export function cdnVersion(cfg: CdnConfig): number {
    const t = Math.floor(Date.parse(cfg.setAt ?? "") / 1000);
    return Number.isFinite(t) ? Math.min(Math.max(t, 1), 2147483647) : 1;
}

export interface CdnFiles { h1: string; h2: string; v: number; mapping: string; manifest: string; directory: string }

const hash16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Whether a release has content for a row platform. An Addressables release
 * has a folder per Unity build target; it matches the row platform by
 * lowercase name (Android = android, StandaloneLinux64 = standalonelinux64).
 * A manifest-bundle release lists its platforms in manifests.
 */
export function releaseCoversPlatform(r: ReleaseInfo, platform: string): boolean {
    if (r.platforms) return Object.keys(r.platforms).some((p) => p.toLowerCase() === platform);
    return !!r.manifests[platform];
}

/**
 * A row's release, if it can be used: it loads and has a manifest bundle for
 * the row's platform. Otherwise the row stays embedded, so a deleted or
 * damaged release can't break boot.
 */
function usableRelease(e: CdnEntry, load: ReleaseLoader | undefined): { release: ReleaseInfo; url: string } | null {
    if (!e.release || !load) return null;
    const release = load(e.release);
    if (!release) return null;
    if (releaseCoversPlatform(release, e.platform)) return { release, url: release.manifests[e.platform] ?? "" };
    return null;
}

export function buildCdnFiles(cfg: CdnConfig, origin: string, loadRelease?: ReleaseLoader): CdnFiles {
    const v = cdnVersion(cfg);
    const entries = [...cfg.entries].sort(byEntry);
    const used = new Map<string, ReleaseInfo>();
    const directory = JSON.stringify({
        directory: entries.map((e) => {
            const u = usableRelease(e, loadRelease);
            if (u) used.set(u.release.id, u.release);
            return {
                client: e.client, platform: e.platform, environment: "production",
                content: u ? u.release.id : "embedded", useEmbeddedContent: !u,
                url: u ? u.url : "", abtest: "", contentVersion: e.contentVersion, releaseScheduleName: "", releaseDate: "2016-01-01 00:00:00 -08:00", decryptionKey: "",
            };
        }),
    });
    const h2 = hash16(directory);
    const crc = Bun.hash.crc32(directory).toString(16).toUpperCase().padStart(8, "0");
    // The manifest names its own hash, so H1 is taken with version blank,
    // then filled in. unique stays in, so a republish is a new file name.
    const paths: Record<string, { crc: string; v: string }> = { "ClientManifestDirectory.json": { crc, v: h2 } };
    for (const r of [...used.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (r.platforms) continue; // fetched through the Addressables catalog, not the manifest
        for (const name of Object.keys(r.files).sort()) paths[name] = { crc: r.files[name]!.crc!, v: r.id };
    }
    const body = (version: string, unique: string) => JSON.stringify({
        version, unique, cdnRoot: `${origin}/cdn.disney.io`, url: "", paths,
    });
    const h1 = hash16(body("", String(v)));
    return {
        h1, h2, v, directory,
        manifest: body(h1, String(v)),
        mapping: JSON.stringify({ default: { n: `manifests/cpipe.${h1}.json`, v } }),
    };
}
