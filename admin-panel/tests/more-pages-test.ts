// More: the word filter and reason template pages (admin and up).
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "mod@x.com", role: "moderator", extras: [], linkedSwid: null });
store.upsertStaff("boss@x.com", { email: "adm@x.com", role: "admin", extras: [], linkedSwid: null });
await createPlayer(s.servers.api.base, s.servers.api.dbPath, "{mp-p}", "MorePlayer");
const text = async (p: string, who = "adm@x.com") => { const r = await s.get(p, who); return { r, t: await r.text() }; };
const audits = (action: string) => queryAudit(store, { action, limit: 20 });

try {
  let { r, t } = await text("/more", "mod@x.com");
  check(!t.includes('href="/filter"') && !t.includes('href="/templates"'), "moderator's More doesn't list Filter or Templates");
  check((await s.get("/filter", "mod@x.com")).status === 403 && (await s.get("/templates", "mod@x.com")).status === 403, "moderator gets 403 on both pages");
  check((await s.post("/filter/add", "mod@x.com", { pattern: "x", kind: "word", action: "mask", reason: "r" })).status === 403, "and can't add a rule");
  ({ t } = await text("/more"));
  check(t.includes('href="/filter"') && t.includes('href="/templates"'), "admin's More lists both");

  // Filter
  ({ r, t } = await text("/filter"));
  check(r.status === 200 && t.includes('name="pattern"') && t.includes('name="reason"'), "filter page: rules and the add form");
  r = await s.post("/filter/add", "adm@x.com", { pattern: "badword", kind: "word", action: "mask", reason: "" });
  check(r.status === 400, "adding a rule needs a reason");
  r = await s.post("/filter/add", "adm@x.com", { pattern: "badword", kind: "word", action: "mask", reason: "Common abuse" }, { csrf: null });
  check(r.status === 403, "and a CSRF token");
  r = await s.post("/filter/add", "adm@x.com", { pattern: "badword", kind: "word", action: "mask", reason: "Common abuse" });
  check(r.status === 303, `add a word rule (${r.status})`);
  ({ t } = await text("/filter"));
  check(t.includes("badword"), "the rule is listed");
  let a = audits("filter.edit").filter((x) => x.result === "ok");
  check(a.length === 1 && a[0]!.reason === "Common abuse" && JSON.stringify(a[0]!.params).includes("badword"), "audited as filter.edit with the pattern");
  r = await s.post("/filter/add", "adm@x.com", { pattern: "(unclosed", kind: "regex", action: "block", reason: "test" });
  const bad = await r.text();
  check(r.status === 400 && bad.includes("not a valid regex"), "a bad regex shows the listener's message");
  r = await s.post("/filter/add", "adm@x.com", { pattern: "(a+)+", kind: "regex", action: "block", reason: "test" });
  check(r.status === 400 && (await r.text()).includes("freeze chat"), "a catastrophic regex is refused");
  r = await s.post("/filter/add", "adm@x.com", { pattern: "<b>x</b>", kind: "word", action: "block", reason: "escape test" });
  ({ t } = await text("/filter"));
  check(t.includes("&lt;b&gt;x&lt;/b&gt;") && !t.includes("<b>x</b>"), "rules are shown escaped");
  const id = t.match(/\/filter\/(\d+)\/remove/)?.[1];
  check(!!id, "each rule has a remove action");
  r = await s.post(`/filter/${id}/remove`, "adm@x.com", { reason: "" });
  check(r.status === 400, "removing needs a reason");
  r = await s.post(`/filter/${id}/remove`, "adm@x.com", { reason: "No longer needed" });
  check(r.status === 303 && audits("filter.edit").filter((x) => x.result === "ok").length === 3, "removed and audited");
  r = await s.post(`/filter/99999/remove`, "adm@x.com", { reason: "nothing" });
  check(r.status === 404 || r.status === 303, "removing an unknown rule doesn't break");

  // Templates
  ({ r, t } = await text("/templates"));
  check(r.status === 200 && t.includes("Spamming chat") && t.includes("Asked to be kicked"), "templates page lists the seeds");
  r = await s.post("/templates", "adm@x.com", { label: "Posting links", applies_to: "mute", sort: "5" });
  check(r.status === 303, `add a template (${r.status})`);
  ({ t } = await text("/templates"));
  check(t.includes("Posting links"), "it is listed");
  t = await (await s.get(`/players/${encodeURIComponent("{mp-p}")}/mute`, "mod@x.com")).text();
  check(t.includes("Posting links"), "the new template is a chip in the mute form");
  t = await (await s.get(`/players/${encodeURIComponent("{mp-p}")}/kick`, "mod@x.com")).text();
  check(!t.includes("Posting links"), "…and not in the kick form");
  r = await s.post("/templates", "adm@x.com", { label: "", applies_to: "mute", sort: "5" });
  check(r.status === 400, "an empty label → 400");
  r = await s.post("/templates", "adm@x.com", { label: "x — y", applies_to: "mute", sort: "5" });
  check(r.status === 400, "a label with the separator → 400");
  r = await s.post("/templates", "adm@x.com", { label: "x", applies_to: "nope", sort: "5" });
  check(r.status === 400, "unknown action → 400");
  ({ t } = await text("/templates"));
  const tid = t.match(/\/templates\/(\d+)\/toggle/)?.[1];
  r = await s.post(`/templates/${tid}/toggle`, "adm@x.com", {});
  check(r.status === 303, "toggle a template");
  r = await s.post("/templates", "adm@x.com", { id: tid!, label: "Renamed one", applies_to: "any", sort: "1" });
  ({ t } = await text("/templates"));
  check(t.includes("Renamed one"), "edit a template");
  r = await s.post("/templates", "mod@x.com", { label: "nope", applies_to: "any", sort: "1" });
  check(r.status === 403, "moderators can't edit templates");
  a = audits("templates.edit");
  check(a.length >= 3 && a.every((x) => ["ok", "failed", "denied"].includes(x.result)) && a.filter((x) => x.result === "ok").length >= 3, "template edits are audited");
  r = await s.post(`/templates/99999/toggle`, "adm@x.com", {});
  check(r.status === 404, "toggling an unknown template → 404");
} finally {
  await s.stop();
}
finish();
process.exit(0);
