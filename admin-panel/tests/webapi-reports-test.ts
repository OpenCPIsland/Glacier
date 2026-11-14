// web-api admin listener: the reports queue (reports.view / reports.resolve)
// and the word filter (filter.view / filter.edit, admin and owner only).
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { startWebApi, makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { signHeaders, type Actor } from "../shared/signing.ts";

const { check, finish } = makeChecker();
const REPO = resolve(import.meta.dir, "../..");
const SECRET = "d".repeat(64);
const PORT = 18191 + (process.pid % 300);
const env = { ALLOW_SWID_AUTH: "1", BUN_OPTIONS: `--preload=${REPO}/web-api/src/admin/index.ts`, ADMIN_PANEL_SECRET: SECRET, WEBAPI_ADMIN_PORT: String(PORT) };
const mod: Actor = { email: "mod@x.com", role: "moderator", extras: [] };
const admin: Actor = { email: "admin@x.com", role: "admin", extras: [] };

const api = await startWebApi({ env });
const call = async (actor: Actor, action: string, method: "GET" | "POST", path: string, body?: unknown) => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = { "Content-Type": "application/json", ...signHeaders(SECRET, method, path, raw, actor, action) };
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: method === "POST" ? raw : undefined });
      return { status: res.status, json: await res.json().catch(() => null) as any };
    } catch { await Bun.sleep(100); }
  }
  throw new Error("admin listener never came up");
};
const exec = (sql: string, ...a: any[]) => { const d = new Database(api.dbPath); d.query(sql).run(...a); d.close(); };
const verify = async (message: string) => {
  const v = await fetch(`${api.base}/chat/v1/message/verify`, {
    method: "POST", headers: { Authorization: "Basic " + btoa("{wr-carol}:x"), "Content-Type": "application/json" },
    body: JSON.stringify({ senderSessionId: 1, message, emotion: 0, moderated: false }),
  });
  return ((await v.json().catch(() => null)) as any)?.data?.message;
};

try {
  await createPlayer(api.base, api.dbPath, "{wr-carol}", "WrCarol");
  await createPlayer(api.base, api.dbPath, "{wr-dave}", "WrDave");
  for (let i = 0; i < 55; i++) exec("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source) VALUES ('{wr-dave}', '{wr-carol}', ?, 'cpi')", `r${i}`);
  exec("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source) VALUES ('{wr-carol}', '{wr-dave}', 'mixy', 'mix')");
  exec("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source) VALUES ('{wr-carol}', 'name:Ghosty', 'who', 'cpi')");
  exec("INSERT INTO mix_reports (reporter_swid, reported_swid, reason, source, status) VALUES ('{wr-carol}', '{wr-dave}', 'old', 'cpi', 'dismissed')");

  check((await call(mod, "players.view", "POST", "/reports", { status: "open" })).status === 403, "signed for another action → 403");
  let r = await call(mod, "reports.view", "POST", "/reports", { status: "open" });
  check(r.status === 200 && r.json?.reports?.length === 50 && typeof r.json?.next === "number", `first page: 50 + next (${r.json?.reports?.length}, ${r.json?.next})`);
  const first = r.json.reports[0];
  check(first.reason === "who" && first.reported.swid === null && first.reported.name === "Ghosty", `newest first; an unknown reported name has swid null (${JSON.stringify(first)})`);
  check(r.json.reports[1].reported.name === "WrDave" && r.json.reports[1].reporter.name === "WrCarol" && r.json.reports[1].source === "mix", "names resolved for reporter and reported");
  r = await call(mod, "reports.view", "POST", "/reports", { status: "open", before: r.json.next });
  check(r.json?.reports?.length === 7 && r.json?.next === null, `second page (${r.json?.reports?.length}, ${r.json?.next})`);
  r = await call(mod, "reports.view", "POST", "/reports", { status: "open", source: "mix" });
  check(r.json?.reports?.length === 1 && r.json.reports[0].reason === "mixy", "source filter");
  r = await call(mod, "reports.view", "POST", "/reports", { status: "closed" });
  check(r.json?.reports?.length === 1 && r.json.reports[0].status === "dismissed", "closed = actioned or dismissed");
  for (const body of [{ status: "x" }, { status: "open", source: "web" }, { status: "open", before: "3" }]) {
    check((await call(mod, "reports.view", "POST", "/reports", body)).status === 400, `bad list body ${JSON.stringify(body)} → 400`);
  }

  const id = first.id;
  r = await call(mod, "reports.resolve", "POST", "/report/resolve", { id, status: "dismissed", reason: "Not a real report" });
  check(r.status === 200, "resolve → 200");
  const d = new Database(api.dbPath, { readonly: true });
  const row = d.query("SELECT * FROM mix_reports WHERE id = ?").get(id) as any;
  d.close();
  check(row.status === "dismissed" && row.resolved_by === "panel:mod@x.com" && row.resolution === "Not a real report" && !!row.resolved_at, `resolution stored (${JSON.stringify(row)})`);
  r = await call(mod, "reports.resolve", "POST", "/report/resolve", { id, status: "actioned", reason: "x" });
  check(r.status === 409, "resolving a closed report → 409");
  check((await call(mod, "reports.resolve", "POST", "/report/resolve", { id: 99999, status: "actioned", reason: "x" })).status === 404, "unknown report → 404");
  check((await call(mod, "reports.resolve", "POST", "/report/resolve", { id, status: "open", reason: "x" })).status === 400, "status must be actioned or dismissed");
  check((await call(mod, "reports.resolve", "POST", "/report/resolve", { id, status: "actioned" })).status === 400, "a reason is required");

  // Filter
  check((await call(mod, "filter.view", "GET", "/filter")).status === 403, "moderators can't list filter rules");
  r = await call(admin, "filter.view", "GET", "/filter");
  check(r.status === 200 && Array.isArray(r.json?.rules), "admins list filter rules");
  check((await call(mod, "filter.edit", "POST", "/filter/add", { pattern: "zork", kind: "word", action: "mask", reason: "x" })).status === 403, "moderators can't add rules");
  r = await call(admin, "filter.edit", "POST", "/filter/add", { pattern: "zork", kind: "word", action: "mask", reason: "New slang" });
  check(r.status === 200 && typeof r.json?.id === "number", "admin adds a word rule");
  check(await verify("hi zork") === "hi ****", "the rule masks chat right away");
  for (const body of [{ pattern: "(", kind: "regex", action: "mask", reason: "x" }, { pattern: "", kind: "word", action: "mask", reason: "x" },
    { pattern: "x".repeat(201), kind: "word", action: "mask", reason: "x" }, { pattern: "a", kind: "glob", action: "mask", reason: "x" },
    { pattern: "a", kind: "word", action: "delete", reason: "x" }, { pattern: "(a+)+$", kind: "regex", action: "mask", reason: "x" },
    { pattern: "(\\w*)*x", kind: "regex", action: "mask", reason: "x" }]) {
    const bad = await call(admin, "filter.edit", "POST", "/filter/add", body);
    check(bad.status === 400 && typeof bad.json?.error === "string", `refused rule ${JSON.stringify(body.pattern).slice(0, 30)} ${body.kind} ${body.action} → 400 (${bad.status} ${bad.json?.error})`);
  }
  r = await call(admin, "filter.edit", "POST", "/filter/remove", { id: r.json.id, reason: "Too broad" });
  check(r.status === 200 && r.json?.removed === true, "admin removes the rule");
  check(await verify("hi zork") === "hi zork", "and chat is no longer masked");
  check((await call(admin, "filter.edit", "POST", "/filter/remove", { id: 99999, reason: "x" })).json?.removed === false, "removing an unknown rule → removed false");
} finally {
  await api.stop();
}
finish(api.logs());
