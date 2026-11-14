// Reports queue: filters, paging, resolving, resolving by acting on the
// player, escaping, and the open-reports badge.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com"]);
const api = s.servers.api;
const store = openStore(s.dbPath, ["boss@x.com"]);
store.upsertStaff("boss@x.com", { email: "mod@x.com", role: "moderator", extras: [], linkedSwid: null });
const [REP, TARGET, T2] = ["{rp-rep}", "{rp-target}", "{rp-t2}"];
for (const [swid, name] of [[REP, "Reporter"], [TARGET, "Target"], [T2, "Target2"]] as const) await createPlayer(api.base, api.dbPath, swid, name);
const EVIL = "<img src=x onerror=1>‮rude";
const db = new Database(api.dbPath);
const add = (rep: string, tgt: string, reason: string, source: string, status = "open") =>
  Number(db.query("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source, status, created_at) VALUES (?,?,?,?,?, datetime('now'))").run(rep, tgt, reason, source, status).lastInsertRowid);
const r1 = add(REP, TARGET, EVIL, "cpi");
const r2 = add(REP, T2, "mix report", "mix");
const r3 = add(REP, "name:Ghost Player", "unknown name", "cpi");
const rc = add(REP, TARGET, "old closed", "cpi", "dismissed");
const text = async (p: string) => (await s.get(p, "mod@x.com")).text();
const audits = (target: string) => queryAudit(store, { action: "reports.resolve", target, limit: 10 });
const pu = (swid: string) => `/players/${encodeURIComponent(swid)}`;

try {
  let t = await text("/reports");
  check(t.includes("&lt;img src=x onerror=1&gt;") && !t.includes("<img src=x") && !t.includes("‮"), "a hostile report reason is escaped");
  check(t.includes("mix report") && t.includes("unknown name") && !t.includes("old closed"), "default: open reports, all sources");
  check(t.includes(`href="${pu(TARGET)}"`) && t.includes("Ghost Player") && !t.includes("name:Ghost"), "reported players link to their page; unknown names show without a link");
  for (const href of ["/reports?status=closed", "/reports?source=mix", "/reports?source=cpi"]) check(t.includes(`href="${href}`), `chip ${href}`);
  t = await text("/reports?source=mix");
  check(t.includes("mix report") && !t.includes("unknown name"), "source chip filters");
  t = await text("/reports?status=closed");
  check(t.includes("old closed") && !t.includes("mix report"), "closed chip lists closed reports");
  t = await text("/reports?status=bogus&source=x&before=abc");
  check(t.includes("mix report"), "bad filters fall back to defaults");

  // nav badge: /reports learns the count, other pages show it
  t = await text("/me");
  check(/class="badge"[^>]*>3</.test(t) || /data-live="openReports">3</.test(t), "the open-reports count is a badge in the nav");

  // resolving
  let r = await s.post(`/reports/${r2}/resolve`, "mod@x.com", { outcome: "dismissed", reason: "" });
  check(r.status === 400 && db.query("SELECT status FROM mix_reports WHERE id = ?").get(r2).status === "open", "resolving needs a reason");
  r = await s.post(`/reports/${r2}/resolve`, "mod@x.com", { outcome: "bogus", reason: "x" });
  check(r.status === 400, "unknown outcome → 400");
  r = await s.post(`/reports/${r2}/resolve`, "mod@x.com", { outcome: "dismissed", reason: "Not a rule break" }, { csrf: null });
  check(r.status === 403, "CSRF required");
  r = await s.post(`/reports/${r2}/resolve`, "mod@x.com", { outcome: "dismissed", reason: "Not a rule break" });
  const row = db.query("SELECT status, resolved_by, resolution FROM mix_reports WHERE id = ?").get(r2) as any;
  check(r.status === 303 && (r.headers.get("location") ?? "").includes("done=resolved") && row.status === "dismissed" && row.resolved_by === "panel:mod@x.com" && row.resolution === "Not a rule break", `dismissed with reason (${r.status})`);
  const a = audits(`report:${r2}`);
  check(a.length === 1 && a[0]!.result === "ok" && a[0]!.reason === "Not a rule break" && JSON.stringify(a[0]!.params).includes("dismissed"), "audited as reports.resolve");
  r = await s.post(`/reports/${r2}/resolve`, "mod@x.com", { outcome: "actioned", reason: "again" });
  check(r.status === 409 && audits(`report:${r2}`).length === 2, "resolving twice → 409, audited failed");
  r = await s.post(`/reports/99999/resolve`, "mod@x.com", { outcome: "actioned", reason: "x" });
  check(r.status === 404, "unknown report → 404");
  r = await s.post(`/reports/${r3}/resolve`, "mod@x.com", { outcome: "actioned", reason: "Handled in game" });
  check(r.status === 303 && db.query("SELECT status FROM mix_reports WHERE id = ?").get(r3).status === "actioned", "actioned works");

  // acting on the player from the report resolves it
  t = await text(`/reports`);
  check(t.includes(`${pu(TARGET)}/ban?report=${r1}`) || t.includes(`${pu(TARGET)}/mute?report=${r1}`), "report rows link to the action forms with ?report=");
  t = await text(`${pu(TARGET)}/mute?report=${r1}`);
  check(t.includes(`name="report" value="${r1}"`), "the form carries the report id");
  r = await s.post(`${pu(TARGET)}/mute`, "mod@x.com", { reason: "Swearing or filter bypass", minutes: "10", report: String(r1) });
  const rr = db.query("SELECT status, resolution FROM mix_reports WHERE id = ?").get(r1) as any;
  check(r.status === 303 && rr.status === "actioned" && rr.resolution === "Swearing or filter bypass", `a mute from a report resolves it as actioned with the same reason (${JSON.stringify(rr)})`);
  check(audits(`report:${r1}`).some((x) => x.result === "ok"), "…with its own audit row");
  r = await s.post(`${pu(T2)}/kick`, "mod@x.com", { reason: "x", report: "99999" });
  check(r.status === 303, "an unknown report id on an action doesn't break the action");
  r = await s.post(`${pu(T2)}/kick`, "mod@x.com", { reason: "x", report: "abc" });
  check(r.status === 303, "a malformed report id is ignored");

  // paging
  for (let i = 0; i < 55; i++) add(REP, TARGET, `bulk ${i}`, "cpi");
  t = await text("/reports");
  const next = t.match(/href="\/reports\?[^"]*before=(\d+)/)?.[1];
  check((t.match(/data-report=/g) ?? []).length === 50 && !!next, "50 per page with an Older link");
  t = await text(`/reports?before=${next}`);
  check((t.match(/data-report=/g) ?? []).length === 5 && !/href="\/reports\?[^"]*before=/.test(t), "the rest on page two, no further link");
  check((await s.get("/reports", null)).status === 403, "no JWT → 403");
} finally {
  db.close();
  await s.stop();
}
finish();
process.exit(0);
