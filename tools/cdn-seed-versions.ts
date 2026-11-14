// Prints CDN version rows for the admin panel's CDN page, taken from a
// client repo's git history: for every ClientVersion that client_info.asset
// ever had, the embedded content version (the last `contentversion:` line of
// embedded_content_manifest.txt) from the newest commit that had it.
//
//   bun tools/cdn-seed-versions.ts <client repo> [--platforms=a,b]
//
// Rows go to stdout as JSON, ready for the page's import box; warnings go to
// stderr. This tool only prints.
import { validateCdnConfig, CDN_PLATFORMS, type CdnEntry, type CdnPlatform } from "../web-api/src/services/cdnManifest.ts";

const DESKTOP: CdnPlatform[] = ["standalonewindows64", "standaloneosx", "standalonelinux64"];

function git(repo: string, ...args: string[]): { ok: boolean; out: string } {
    const r = Bun.spawnSync(["git", "-C", repo, ...args]);
    return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

export function seedRows(repo: string, platforms: CdnPlatform[] = DESKTOP): { rows: CdnEntry[]; warnings: string[] } {
    const ls = git(repo, "ls-files");
    if (!ls.ok) throw new Error(`${repo} is not a git repository`);
    const files = ls.out.split("\n");
    const one = (suffix: string) => {
        const m = files.filter((f) => f.endsWith(suffix));
        if (m.length !== 1) throw new Error(`expected exactly one ${suffix} in the repo, found ${m.length}`);
        return m[0]!;
    };
    const info = one("/Resources/Configuration/client_info.asset");
    const manifest = one("/Resources/Configuration/embedded_content_manifest.txt");

    const latest = new Map<string, { content: string; sha: string; seen: Set<string> }>();
    for (const sha of git(repo, "log", "--format=%H", "--reverse", "--", info, manifest).out.split("\n").filter(Boolean)) {
        const a = git(repo, "show", `${sha}:${info}`), b = git(repo, "show", `${sha}:${manifest}`);
        if (!a.ok || !b.ok) continue;
        const version = a.out.match(/^\s*ClientVersion:\s*(\S+)/m)?.[1];
        const contents = [...b.out.matchAll(/^contentversion:([0-9a-f]{40})\s*$/gm)];
        const content = contents[contents.length - 1]?.[1];
        if (!version || !content) continue;
        const prev = latest.get(version);
        latest.set(version, { content, sha: sha.slice(0, 7), seen: new Set([...(prev?.seen ?? []), content]) });
    }

    const warnings: string[] = [];
    const rows: CdnEntry[] = [];
    for (const [client, v] of latest) {
        if (v.seen.size > 1) warnings.push(`${client}: content version changed ${v.seen.size} times; using ${v.content} from ${v.sha}`);
        for (const platform of platforms) rows.push({ client, platform, contentVersion: v.content });
    }
    const checked = validateCdnConfig({ enabled: true, entries: rows });
    if (!checked.ok) throw new Error(checked.error);
    return { rows: checked.config.entries, warnings };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const repo = args.find((a) => !a.startsWith("--"));
    const pf = args.find((a) => a.startsWith("--platforms="))?.slice("--platforms=".length).split(",");
    if (!repo || (pf && !pf.every((p) => (CDN_PLATFORMS as readonly string[]).includes(p)))) {
        console.error(`usage: bun tools/cdn-seed-versions.ts <client repo> [--platforms=${CDN_PLATFORMS.join(",")}]`);
        process.exit(1);
    }
    try {
        const { rows, warnings } = seedRows(repo, pf as CdnPlatform[] | undefined);
        for (const w of warnings) console.error(`warning: ${w}`);
        console.log("[\n" + rows.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n]");
    } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
    }
}
