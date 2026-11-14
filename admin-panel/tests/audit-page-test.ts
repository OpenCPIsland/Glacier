// Audit log page: admin-only, newest first, filters, keyset paging, chain
// verification, and escaping of stored text.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { openStore } from "../src/store.ts";
import { appendAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "adm@x.com", role: "admin", extras: [], linkedSwid: null });
store.upsertStaff("boss@x.com", { email: "mod@x.com", role: "moderator", extras: [], linkedSwid: null });

const ids = (page: string) => [...page.matchAll(/<tr data-id="(\d+)"/g)].map((m) => Number(m[1]));

try {
  for (let i = 0; i < 70; i++) {
    appendAudit(store, { actor: i % 2 ? "boss@x.com" : "adm@x.com", role: "owner", action: "staff.edit", target: `t${i}@x.com`, params: { i }, reason: null, result: i % 10 === 0 ? "denied" : "ok", detail: null });
  }
  appendAudit(store, { actor: "boss@x.com", role: "owner", action: "staff.edit", target: "evil‮txt<b>", params: null, reason: null, result: "ok", detail: "<script>x</script>" });

  let r = await s.get("/audit", "mod@x.com");
  check(r.status === 403, "moderator can't open the audit log");

  r = await s.get("/audit", "adm@x.com");
  let page = await r.text();
  let got = ids(page);
  check(r.status === 200 && got.length === 50 && got[0]! > got[1]! && got[0] === Math.max(...got), `admin sees 50 rows, newest first (${got.length}, first ${got[0]})`);
  check(page.includes("evil\\u{202e}txt&lt;b&gt;") && !page.includes("<b>txt") && page.includes("&lt;script&gt;x&lt;/script&gt;"), "stored text renders escaped, bidi override visible");

  const next = page.match(/href="(\/audit\?[^"]*before=\d+[^"]*)"/)?.[1]?.replace(/&amp;/g, "&");
  check(!!next, "there is a next-page link");
  page = await (await s.get(next!, "adm@x.com")).text();
  const got2 = ids(page);
  check(got2.length > 0 && Math.max(...got2) < Math.min(...got), `next page continues below the first (${got2[0]})`);

  page = await (await s.get("/audit?result=denied", "adm@x.com")).text();
  check(ids(page).length >= 7 && !page.includes("<td>ok</td>") && page.includes("<td>denied</td>"), "result=denied shows only denied rows");
  page = await (await s.get("/audit?actor=adm%40x.com&action=staff.edit", "adm@x.com")).text();
  check(ids(page).length > 0 && !/<td>boss@x\.com<\/td>/.test(page), "actor filter");
  page = await (await s.get(`/audit?from=2000-01-01&to=2000-01-02`, "adm@x.com")).text();
  check(ids(page).length === 0, "date range with nothing in it → no rows");
  r = await s.get("/audit?from=yesterday&before=abc", "adm@x.com");
  check(r.status === 200, "bad filter values are ignored, not a 500");

  r = await s.post("/audit/verify", "adm@x.com", {});
  page = await r.text();
  check(r.status === 200 && /Chain intact \(\d+ entries\)/.test(page), `verify: intact (${page.match(/Chain[^<]*/)?.[0]})`);

  const raw = new Database(s.dbPath);
  raw.run("UPDATE audit SET target = 'changed' WHERE id = 5");
  raw.close();
  page = await (await s.post("/audit/verify", "adm@x.com", {})).text();
  check(page.includes("Chain broken at entry #5"), `verify: tamper found at #5 (${page.match(/Chain[^<]*/)?.[0]})`);
  check((await s.post("/audit/verify", "mod@x.com", {})).status === 403, "moderator can't run verify");
} finally {
  await s.stop();
}
finish(s.logs());
