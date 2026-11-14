// CDN page, content releases: the releases list and upload form, upload
// refusals (role, id, size, bad zip, taken id), the staged file never left
// behind, the audit row, and the release column surviving a save.
import { readdirSync } from "node:fs";
import { makeChecker } from "../../tools/lib/harness.ts";
import { makeZip } from "../../tools/lib/zipmaker.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "adm@x.com", role: "admin", extras: [], linkedSwid: null });
store.upsertStaff("boss@x.com", { email: "mod@x.com", role: "moderator", extras: [], linkedSwid: null });
const CV = "83523013bb2d807ac74ac353d58d22876a6fee91";

const good = () => makeZip([
  { name: "www/1700000001/ClientBundles/standalonewindows64/aaaa.unity3d", data: "sprite" },
  { name: "www/1700000001/ClientBundles/standalonewindows64/mmmm.unity3d", data: "manifest" },
  { name: "www/1700000002/ClientManifestDirectory.json", data: JSON.stringify({ directory: [{ client: "1.15.0", platform: "standalonewindows64", url: "ClientBundles/standalonewindows64/mmmm.unity3d" }] }) },
]);
const upload = (email: string, id: string | null, bytes: Uint8Array | null, name = "export.zip") => {
  const f = new FormData();
  if (id !== null) f.append("id", id);
  if (bytes) f.append("file", new File([bytes], name, { type: "application/zip" }));
  return s.postForm("/cdn/releases/upload", email, f);
};
const rev = (page: string) => page.match(/name="rev" value="([^"]*)"/)?.[1] ?? "";
const confirmFields = (page: string) => {
  const f: Record<string, string[]> = {};
  for (const m of page.matchAll(/<input type="hidden" name="([a-zA-Z]+)" value="([^"]*)">/g)) if (m[1] !== "_csrf") (f[m[1]!] ??= []).push(m[2]!);
  return f;
};
const staged = () => readdirSync(s.uploadDir);

try {
  let page = await (await s.get("/cdn", "boss@x.com")).text();
  check(page.includes('action="/cdn/releases/upload"') && page.includes('enctype="multipart/form-data"') && page.includes('type="file"') && page.includes("Releases"), "an owner sees the releases section and upload form");
  page = await (await s.get("/cdn", "adm@x.com")).text();
  check(page.includes("Releases") && !page.includes("/cdn/releases/upload"), "an admin sees the releases list but no upload form");

  check((await upload("mod@x.com", "up-1", good())).status === 403, "a moderator can't upload");
  check((await upload("adm@x.com", "up-1", good())).status === 403, "an admin can't upload");
  check(staged().length === 0, "refused roles leave nothing staged");

  let r = await upload("boss@x.com", "../evil", good());
  check(r.status === 400 && (await r.text()).includes("release id") && staged().length === 0, "a bad id is 400, nothing staged");
  r = await upload("boss@x.com", "up-1", null);
  check(r.status === 400 && staged().length === 0, "no file is 400");
  r = await upload("boss@x.com", "up-1", new TextEncoder().encode("not a zip"));
  check(r.status === 400 && staged().length === 0, "a non-zip is 400 and nothing is left staged");
  r = await upload("boss@x.com", "up-1", makeZip([{ name: "../evil", data: "x" }]));
  check(r.status === 400 && staged().length === 0 && readdirSync(s.releasesDir).length === 0, "a hostile zip is 400, nothing staged, no release");

  r = await upload("boss@x.com", "up-1", good());
  page = await r.text();
  check(r.status === 200 && page.includes("up-1") && page.includes("2 bundle"), `an owner's good upload imports (${r.status})`);
  check(staged().length === 0 && readdirSync(s.releasesDir).join() === "up-1", "the staged zip is gone and the release is on disk");
  page = await (await s.get("/cdn", "boss@x.com")).text();
  check(page.includes("<td>up-1</td>") && page.includes("standalonewindows64"), "the release is listed");
  const audits = queryAudit(store, { action: "cdn.edit", result: "ok", limit: 5 });
  check(audits.some((a) => a.target === "cdn_release:up-1" && a.actor === "boss@x.com"), "an audit row records the upload");

  r = await upload("boss@x.com", "up-1", good());
  check(r.status === 409 && staged().length === 0, "a taken id is 409, nothing staged");

  // Size cap.
  await s.restartPanel({ CDN_UPLOAD_MAX_BYTES: "500" });
  r = await upload("boss@x.com", "up-2", good());
  check(r.status === 413 && staged().length === 0, `over the size cap is 413 (${r.status})`);
  await s.restartPanel({ CDN_UPLOAD_MAX_BYTES: String(100 * 1024 * 1024) });

  // The release column.
  page = await (await s.get("/cdn", "boss@x.com")).text();
  check(page.includes('name="release"') && page.includes('<option value="up-1"'), "rows get a release choice listing imported releases");
  const fields = { enabled: "1", client: ["1.15.0", ""], platform: ["standalonewindows64", "android"], contentVersion: [CV, ""], release: ["up-1", ""], rev: rev(page) };
  r = await s.post("/cdn/save", "boss@x.com", fields);
  page = await r.text();
  check(r.status === 200 && page.includes("up-1") && page.includes('name="release" value="up-1"'), "review shows the release and carries it into the confirm form");
  const cf = confirmFields(page);
  r = await s.post("/cdn/save", "boss@x.com", cf as any);
  check(r.status === 200 && (await r.text()).includes("Saved."), "confirm saves a row with a release");
  const mapping: any = await (await fetch(`${s.servers.api.base}/__mapping_cpremix_prod.json`)).json();
  const manifest: any = await (await fetch(`${s.servers.api.base}/${mapping.default.n}`)).json();
  check(manifest.paths["ClientBundles/standalonewindows64/aaaa.unity3d"]?.v === "up-1", "the public manifest now lists the release's bundles");

  // Saving the page again, unchanged, must keep the release (the old form rebuilt rows without it).
  page = await (await s.get("/cdn", "boss@x.com")).text();
  check(/<option value="up-1" selected>/.test(page), "the saved row shows its release selected");
  const again = { enabled: "1", client: ["1.15.0", ""], platform: ["standalonewindows64", "android"], contentVersion: [CV, ""], release: ["up-1", ""], rev: rev(page) };
  r = await s.post("/cdn/save", "boss@x.com", again);
  page = await r.text();
  check(page.includes("Added: none") && page.includes("Removed: none"), "an unchanged save adds and removes nothing");

  // Changing a row's release is a visible change in review.
  r = await s.post("/cdn/save", "boss@x.com", { ...again, release: ["", ""] });
  page = await r.text();
  check(page.includes("Added: <code>1.15.0 standalonewindows64") && page.includes("Removed: <code>1.15.0 standalonewindows64 83523013 up-1"), "dropping a release shows as the row changing");

  // Unknown releases are refused by the web API.
  r = await s.post("/cdn/save", "boss@x.com", { ...again, release: ["nope", ""] });
  check(r.status === 400 && (await r.text()).includes("not found"), "a release that doesn't exist is refused with the reason");

  // JSON import can carry a release.
  const cur = rev(await (await s.get("/cdn", "boss@x.com")).text());
  r = await s.post("/cdn/save", "boss@x.com", { enabled: "1", client: ["1.15.0"], platform: ["standalonewindows64"], contentVersion: [CV], release: ["up-1"], import: JSON.stringify([{ client: "1.14.1", platform: "standalonewindows64", contentVersion: CV, release: "up-1" }]), rev: cur });
  check((await r.text()).includes("Added: <code>1.14.1 standalonewindows64"), "import rows may name a release");

  // An Addressables release (per-platform folders): listed with its platforms and catalog, offered only to rows it covers.
  const HASH = "0123456789abcdef0123456789abcdef";
  const addr = makeZip([
    { name: "Android/catalog_1.17.0.bin", data: "cat" },
    { name: "Android/catalog_1.17.0.hash", data: HASH },
    { name: "Android/a.bundle", data: "b" },
  ]);
  r = await upload("boss@x.com", "addr-1", addr);
  page = await r.text();
  check(r.status === 200 && page.includes("addr-1") && page.includes("catalog_1.17.0.bin"), `an Addressables zip imports and the page names its catalog (${r.status})`);
  page = await (await s.get("/cdn", "boss@x.com")).text();
  check(/<td>addr-1<\/td><td>3<\/td><td>android<\/td>/.test(page), "the releases table shows the Addressables release's bundle count and platform");
  const rowFor = (platform: string) => page.split("<tr>").find((x) => x.includes(`<option value="${platform}" selected>`)) ?? "";
  check(!rowFor("standalonewindows64").includes('value="addr-1"') && rowFor("standalonewindows64").includes('value="up-1"'), "a Windows row isn't offered the Android-only release");
  const newRow = page.split("<tr>").find((x) => x.includes("new row")) ?? "";
  check(newRow.includes('value="addr-1"'), "the new-row dropdown offers every release (the platform isn't chosen yet)");
  check(page.includes("platform folders"), "the upload form describes the Addressables zip");
} finally {
  await s.stop();
}
finish();
