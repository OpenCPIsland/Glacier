// The zip reader behind CDN release uploads: it must extract the generator's
// output exactly, and refuse everything else (path escapes, bombs, bad CRCs,
// encryption, links, unsupported formats) without leaving files outside
// the destination or a half-imported release.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeZip } from "./lib/zipmaker.ts";
import { makeChecker } from "./lib/harness.ts";
import { extractZip, type ZipLimits } from "../web-api/src/services/zipExtract.ts";
import { importReleaseZip, loadRelease } from "../web-api/src/services/cdnReleases.ts";

const { check, finish } = makeChecker();
const root = mkdtempSync(join(tmpdir(), "cdn-zip-"));

let n = 0;
const write = (bytes: Uint8Array) => { const p = join(root, `z${n++}.zip`); writeFileSync(p, bytes); return p; };
const dest = () => { const d = join(root, `d${n++}`); mkdirSync(d); return d; };
const LIM: ZipLimits = { maxEntries: 50, maxTotalBytes: 10_000, maxFileBytes: 6_000 };
const fails = (zip: Uint8Array, re: RegExp, lim: ZipLimits = LIM) => {
    const d = dest();
    try { extractZip(write(zip), d, lim); return false; } catch (e) { return re.test(String(e)); }
};
const tree = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((x) => x.isFile()).map((x) => join(x.parentPath, x.name).slice(d.length + 1)).sort();

try {
    const SPRITE = new Uint8Array(3000).map((_, i) => (i * 7) % 256);
    const good = makeZip([
        { name: "www/" }, { name: "www/1700000001/" },
        { name: "www/1700000001/ClientBundles/android/aaaa.unity3d", data: SPRITE },
        { name: "www/1700000001/ClientBundles/android/stored.unity3d", data: "stored bytes", method: 0 },
        { name: "www/empty.txt", data: "" },
    ]);
    let d = dest();
    const names = extractZip(write(good), d, LIM);
    check(tree(d).join() === "www/1700000001/ClientBundles/android/aaaa.unity3d,www/1700000001/ClientBundles/android/stored.unity3d,www/empty.txt", "files extract to their paths");
    check(names === 3, "returns the number of files");
    check(Buffer.compare(readFileSync(join(d, "www/1700000001/ClientBundles/android/aaaa.unity3d")), Buffer.from(SPRITE)) === 0 && readFileSync(join(d, "www/1700000001/ClientBundles/android/stored.unity3d"), "utf8") === "stored bytes", "deflated and stored entries come out byte for byte");

    for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/evil.txt", "a\\..\\evil.txt", "C:/evil.txt", "a/./b/../../../x", "nul\0.txt", "", "a//b"]) {
        const bad = makeZip([{ name, data: "x" }]);
        check(fails(bad, /path|name/i), `refuses entry name ${JSON.stringify(name)}`);
    }
    check(!existsSync(join(root, "evil.txt")) && !existsSync("/etc/evil.txt"), "nothing was written outside the destination");
    check(fails(makeZip([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]), /duplicate/i), "refuses duplicate names");
    check(fails(makeZip([{ name: "a.txt", data: "x" }, { name: "A.txt", data: "y" }]), /duplicate/i), "refuses names that differ only by case");
    check(fails(makeZip(Array.from({ length: 51 }, (_, i) => ({ name: `f${i}`, data: "x" }))), /entries/i), "refuses more entries than the limit");
    check(fails(makeZip([{ name: "big.bin", data: new Uint8Array(6_001) }]), /size|large/i), "refuses a file over the per-file limit (declared)");
    check(fails(makeZip([{ name: "a", data: new Uint8Array(5_000) }, { name: "b", data: new Uint8Array(5_001) }]), /total|large/i), "refuses a total over the limit");

    // A bomb lies about its size: the declared size is small, the data inflates huge.
    const bomb = makeZip([{ name: "bomb.bin", data: new Uint8Array(500_000), declaredSize: 10 }]);
    check(fails(bomb, /size|large|mismatch/i), "a deflate bomb lying about its size is refused");
    const bombD = dest();
    try { extractZip(write(bomb), bombD, LIM); } catch {}
    check(!existsSync(join(bombD, "bomb.bin")) || readFileSync(join(bombD, "bomb.bin")).length <= LIM.maxFileBytes, "…and never writes more than the limit");

    check(fails(makeZip([{ name: "a.txt", data: "hello", crc: 12345 }]), /crc/i), "refuses a CRC mismatch");
    check(fails(makeZip([{ name: "a.txt", data: "hello", flags: 1 }]), /encrypt/i), "refuses encrypted entries");
    check(fails(makeZip([{ name: "a.txt", data: "hello", method: 12 }]), /method|unsupported/i), "refuses unsupported compression");
    check(fails(makeZip([{ name: "link", data: "target", unixMode: 0o120777 }]), /link|special/i), "refuses symlinks");
    check(fails(new Uint8Array([1, 2, 3, 4, 5]), /zip/i), "refuses a non-zip");
    check(fails(makeZip([{ name: "a.txt", data: "hello" }], { truncate: 30 }), /zip/i), "refuses a truncated zip");
    check(fails(new Uint8Array(0), /zip/i), "refuses an empty file");

    // --- importReleaseZip: zip → release, atomically ---
    const releases = join(root, "releases");
    mkdirSync(releases);
    const exportZip = makeZip([
        { name: "www/1700000001/ClientBundles/standalonewindows64/aaaa.unity3d", data: "sprite" },
        { name: "www/1700000001/ClientBundles/standalonewindows64/mmmm.unity3d", data: "manifest" },
        { name: "www/1700000002/ClientManifestDirectory.json", data: JSON.stringify({ directory: [{ client: "1.15.0", platform: "standalonewindows64", url: "ClientBundles/standalonewindows64/mmmm.unity3d" }] }) },
        { name: "www/manifests/__manifest_cpremix_prod.0000.json", data: "{}" },
    ]);
    const big: ZipLimits = { maxEntries: 100, maxTotalBytes: 1_000_000, maxFileBytes: 1_000_000 };
    let rel = importReleaseZip(write(exportZip), releases, "zip-1", big);
    check(rel.id === "zip-1" && Object.keys(rel.files).length === 2 && rel.manifests["standalonewindows64"] === "ClientBundles/standalonewindows64/mmmm.unity3d", "a zip of the www folder imports as a release");
    check(loadRelease(releases, "zip-1")?.id === "zip-1", "…and is loadable");
    // Zips made by zipping the folder's contents (no www/ wrapper) work too.
    const flat = makeZip(exportZip ? [
        { name: "1700000001/ClientBundles/android/bbbb.unity3d", data: "s" }, { name: "1700000001/ClientBundles/android/nnnn.unity3d", data: "m" },
        { name: "1700000002/ClientManifestDirectory.json", data: JSON.stringify({ directory: [{ platform: "android", url: "ClientBundles/android/nnnn.unity3d" }] }) },
    ] : []);
    rel = importReleaseZip(write(flat), releases, "zip-2", big);
    check(Object.keys(rel.manifests).join() === "android", "a zip without the www/ wrapper imports too");

    let threw = "";
    try { importReleaseZip(write(makeZip([{ name: "../x", data: "x" }])), releases, "zip-3", big); } catch (e) { threw = String(e); }
    check(threw !== "" && !existsSync(join(releases, "zip-3")), "a bad zip leaves no release");
    threw = ""; try { importReleaseZip(write(exportZip), releases, "zip-1", big); } catch (e) { threw = String(e); }
    check(/exists/.test(threw), "a taken id is refused");
    threw = ""; try { importReleaseZip(write(makeZip([{ name: "readme.txt", data: "hi" }])), releases, "zip-4", big); } catch (e) { threw = String(e); }
    check(threw !== "" && !existsSync(join(releases, "zip-4")), "a zip that isn't an export tree is refused");
    check(readdirSync(releases).sort().join() === "zip-1,zip-2", "no temp folders are left in the releases folder");
} finally {
    rmSync(root, { recursive: true, force: true });
}
finish();
