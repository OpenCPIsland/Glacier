// CPI's POST /moderation/v1/report/name/{name}. The client's ReportPlayerOperation
// puts the reason in an [HttpRequestJsonBody] string field, and HttpRequestJsonBodyAttribute
// sends that string as the body as-is: the real body is the bare text
// `ChatSwearing` (not `"ChatSwearing"`) under Content-Type application/json.
// A JSON parser rejects it, so the report must be read as text.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });

const post = (name: string, body: string, contentType = "application/json") => fetch(`${api.base}/moderation/v1/report/name/${encodeURIComponent(name)}`, {
  method: "POST",
  headers: { Authorization: "Basic " + btoa("{RW-A}:x"), "Content-Type": contentType },
  body,
});
const stored = () => {
  const d = new Database(api.dbPath, { readonly: true });
  try { return d.query("SELECT reason, source, reported_swid FROM mix_reports ORDER BY id").all() as any[]; } finally { d.close(); }
};

try {
  await createPlayer(api.base, api.dbPath, "{RW-A}", "rwalice");
  await createPlayer(api.base, api.dbPath, "{RW-B}", "rwbob");

  // What the real client sends.
  let r = await post("rwbob", "ChatSwearing");
  check(r.status === 200, `bare text body (what the client sends) -> ${r.status}`);
  // Shapes the route has always accepted.
  r = await post("rwbob", JSON.stringify("Harassment"));
  check(r.status === 200, `quoted JSON string -> ${r.status}`);
  r = await post("rwbob", JSON.stringify({ reason: "Spamming" }));
  check(r.status === 200, `JSON object with reason -> ${r.status}`);
  r = await post("rwbob", "ChatInappropriate", "text/plain");
  check(r.status === 200, `text/plain body -> ${r.status}`);

  const rows = stored();
  check(rows.map((x) => x.reason).join() === "ChatSwearing,Harassment,Spamming,ChatInappropriate", `reasons stored as text (${rows.map((x) => x.reason)})`);
  check(rows.every((x) => x.source === "cpi" && x.reported_swid === "{RW-B}"), "all stored as cpi reports of bob");

  // Not a report.
  r = await post("rwbob", "");
  check(r.status === 400, `empty body -> 400 (${r.status})`);
  r = await post("rwbob", "   ");
  check(r.status === 400, `blank body -> 400 (${r.status})`);
  check(stored().length === 4, "refused reports store nothing");

  // A hostile reason is stored as text and can't forge a log line.
  r = await post("rwbob", "x\n[LOGIN] forged-line");
  check(r.status === 200, `reason with a newline -> ${r.status}`);
  await Bun.sleep(200);
  check(!api.logs().split("\n").some((l) => l.startsWith("[LOGIN] forged-line")), "a reason can't start a log line of its own");
} finally {
  await api.stop();
}
finish();
