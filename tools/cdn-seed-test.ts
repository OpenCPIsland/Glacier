// cdn-seed-versions: rows from a throwaway client repo's history, the CLI's
// output and exit codes, and a guard that the tool never writes a database.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker } from "./lib/harness.ts";
import { seedRows } from "./cdn-seed-versions.ts";

const { check, finish } = makeChecker();
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const sh = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", "-C", cwd, ...a]); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };

const repo = mkdtempSync(join(tmpdir(), "cdn-seed-"));
const conf = join(repo, "Game X/Assets/Generated/Resources/Configuration");
mkdirSync(conf, { recursive: true });
sh(repo, "init", "-q");
sh(repo, "config", "user.email", "t@x.com"); sh(repo, "config", "user.name", "t");
const write = (version: string, content: string) => {
  writeFileSync(join(conf, "client_info.asset"), `MonoBehaviour:\n  ClientVersion: ${version}\n  Platform: standalonewindows64\n`);
  writeFileSync(join(conf, "embedded_content_manifest.txt"), `bundle:x\nbaseuri:\ncontentversion:${content}\ncontentmanifesthash:\n`);
  sh(repo, "add", "-A"); sh(repo, "commit", "-qm", `${version} ${content.slice(0, 1)}`);
};
write("1.14.0", A);
write("1.14.0", B);
write("1.15.0", C);

const { rows, warnings } = seedRows(repo);
check(rows.length === 6 && rows.every((r) => (r.client === "1.14.0" && r.contentVersion === B) || (r.client === "1.15.0" && r.contentVersion === C)), "6 rows: each version with its latest contentVersion");
check(JSON.stringify(rows.map((r) => `${r.client} ${r.platform}`)) === JSON.stringify(["1.14.0 standalonelinux64", "1.14.0 standaloneosx", "1.14.0 standalonewindows64", "1.15.0 standalonelinux64", "1.15.0 standaloneosx", "1.15.0 standalonewindows64"]), "sorted, three desktop platforms");
check(warnings.some((w) => w.includes("1.14.0: content version changed 2 times")), `warns about a changed content version (${warnings.join("; ")})`);
check(seedRows(repo, ["standalonelinux64"]).rows.length === 2, "--platforms narrows the rows");

const cli = (dir: string, ...extra: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "cdn-seed-versions.ts"), dir, ...extra]);
const out = cli(repo);
check(out.exitCode === 0 && JSON.stringify(JSON.parse(out.stdout.toString())) === JSON.stringify(rows), "the CLI prints the rows as JSON");
check(cli(repo, "--platforms=standalonelinux64").exitCode === 0 && JSON.parse(cli(repo, "--platforms=standalonelinux64").stdout.toString()).length === 2, "the CLI takes --platforms");
check(cli(mkdtempSync(join(tmpdir(), "cdn-empty-"))).exitCode === 1, "a directory that isn't a client repo exits 1");
check(!/bun:sqlite|Database|setSetting|writeFile/.test(readFileSync(join(import.meta.dir, "cdn-seed-versions.ts"), "utf8")), "the tool only prints: no database or file writes");

finish();
