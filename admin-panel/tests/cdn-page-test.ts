// CDN page: who sees what, dry run → confirm → save, stale confirms,
// import, validation errors, escaping, and the audit row.
import { makeChecker } from "../../tools/lib/harness.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "adm@x.com", role: "admin", extras: [], linkedSwid: null });
store.upsertStaff("boss@x.com", { email: "mod@x.com", role: "moderator", extras: [], linkedSwid: null });
const CV = "83523013bb2d807ac74ac353d58d22876a6fee91";
const WARNING = "Builds not on this list get the forced-upgrade screen. Turning the CDN off fixes it on their next boot.";
const mapping = async () => (await fetch(`${s.servers.api.base}/__mapping_cpremix_prod.json`)).status;
const rev = (page: string) => page.match(/name="rev" value="([^"]*)"/)?.[1] ?? "";
const confirmFields = (page: string) => {
  const f: Record<string, string[]> = {};
  for (const m of page.matchAll(/<input type="hidden" name="([a-zA-Z]+)" value="([^"]*)">/g)) if (m[1] !== "_csrf") (f[m[1]!] ??= []).push(m[2]!);
  return f;
};

try {
  let r = await s.get("/cdn", "mod@x.com");
  check(r.status === 403, "a moderator can't open /cdn");
  check(!(await (await s.get("/me", "mod@x.com")).text()).includes('href="/cdn"'), "a moderator sees no CDN nav link");
  r = await s.get("/cdn", "adm@x.com");
  let page = await r.text();
  check(r.status === 200 && page.includes("<b>off</b>") && page.includes(WARNING) && !page.includes('action="/cdn/save"') && page.includes('href="/cdn"'), "an admin sees it read-only, with the warning");
  r = await s.get("/cdn", "boss@x.com");
  page = await r.text();
  check(page.includes('action="/cdn/save"') && rev(page) === "none", "an owner gets the form");
  check((await s.post("/cdn/save", "adm@x.com", { enabled: "1", client: "1.15.0", platform: "standalonewindows64", contentVersion: CV, rev: "none" })).status === 403, "an admin can't save");

  const fields = { enabled: "1", client: ["1.15.0", ""], platform: ["standalonewindows64", "android"], contentVersion: [CV, ""], rev: "none" };
  r = await s.post("/cdn/save", "boss@x.com", fields);
  page = await r.text();
  check(r.status === 200 && page.includes("Turn the CDN on") && page.includes("1.15.0 standalonewindows64") && page.includes(WARNING) && page.includes('name="confirm" value="1"'), "review shows the change and the warning");
  check((await mapping()) === 404, "review alone saved nothing");
  const cf = confirmFields(page);
  r = await s.post("/cdn/save", "boss@x.com", cf as any);
  page = await r.text();
  check(r.status === 200 && page.includes("Saved.") && (await mapping()) === 200, "confirm saves and the public mapping is served");
  const audits = queryAudit(store, { action: "cdn.edit", result: "ok", limit: 5 });
  const p: any = audits[0]?.params;
  check(audits.length === 1 && audits[0]!.actor === "boss@x.com" && p?.after?.enabled === true && p.after.entries === 1 && p.added.length === 1, "an audit row records the change");

  r = await s.post("/cdn/save", "boss@x.com", cf as any);
  check(r.status === 409 && (await r.text()).includes("changed since you opened"), "the same confirm again → 409");

  const cur = rev(await (await s.get("/cdn", "boss@x.com")).text());
  const imp = JSON.stringify([{ client: "1.15.0", platform: "standalonewindows64", contentVersion: CV }, { client: "1.15.0", platform: "standalonelinux64", contentVersion: CV }]);
  r = await s.post("/cdn/save", "boss@x.com", { enabled: "1", client: ["1.15.0"], platform: ["standalonewindows64"], contentVersion: [CV], import: imp, rev: cur });
  page = await r.text();
  check(page.includes("Keep the CDN on") && page.includes("Added: <code>1.15.0 standalonelinux64") && page.includes("Removed: none"), "import adds only the new row");
  r = await s.post("/cdn/save", "boss@x.com", { enabled: "1", client: ["1.15.0"], platform: ["standalonewindows64"], contentVersion: [CV], import: "not json", rev: cur });
  check(r.status === 400 && (await r.text()).includes("Import isn&#39;t a JSON array of rows."), "bad import → 400");

  r = await s.post("/cdn/save", "boss@x.com", { enabled: "1", client: ["1.15.0"], platform: ["standalonewindows64"], contentVersion: [CV], remove: "0", rev: cur });
  check(r.status === 400 && (await r.text()).includes("can&#39;t turn on with an empty list"), "removing the last row while on → 400");
  r = await s.post("/cdn/save", "boss@x.com", { client: ["1.15.0"], platform: ["standalonewindows64"], contentVersion: [CV], remove: "0", rev: cur });
  check((await r.text()).includes("Turn the CDN off"), "off with an empty list is allowed (review shows turning it off)");

  r = await s.post("/cdn/save", "boss@x.com", { enabled: "1", client: ["<b>1"], platform: ["standalonewindows64"], contentVersion: [CV], rev: cur });
  page = await r.text();
  check(r.status === 400 && page.includes("&lt;b&gt;1") && !page.includes("<b>1"), "a hostile value is refused and shown escaped");
} finally {
  await s.stop();
}
finish(s.logs());
