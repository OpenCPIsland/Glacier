// Imports a CDN content release from a folder, in either layout:
//   - an Addressables update build: <Platform>/ folders (StandaloneLinux64,
//     Android, ...), each with catalog_<version>.bin|json, its .hash, and .bundle files
//   - the client generator's Export/www folder (CreateAssetBundles Step 4)
//
//   bun tools/cdn-import-release.ts <folder> <release-id> [releases-dir]
//
// releases-dir defaults to $CDN_RELEASES_DIR, then web-api/data/cdn-releases.
// Afterwards, give a CDN row that release id in the admin panel.
import { resolve } from "node:path";
import { importRelease } from "../web-api/src/services/cdnReleases.ts";

const [src, id, dirArg] = process.argv.slice(2);
if (!src || !id) {
    console.error("usage: bun tools/cdn-import-release.ts <release folder> <release-id> [releases-dir]");
    process.exit(2);
}
const dir = dirArg ?? process.env.CDN_RELEASES_DIR ?? resolve(import.meta.dir, "../web-api/data/cdn-releases");
try {
    const r = importRelease(resolve(src), resolve(dir), id);
    console.log(`imported release ${r.id} into ${resolve(dir)}`);
    console.log(`${Object.keys(r.files).length} bundle(s)`);
    for (const [platform, path] of Object.entries(r.manifests)) console.log(`  ${platform}: manifest bundle ${path}`);
    for (const [platform, p] of Object.entries(r.platforms ?? {})) console.log(`  ${platform}: ${p.catalog}`);
} catch (e) {
    console.error(`import failed: ${(e as Error).message}`);
    process.exit(1);
}
