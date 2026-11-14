// A staff row that loses panel access (taken out of PANEL_OWNERS, or
// disabled while a server was down) must not keep its linked game
// account's role: the role lock would stop in-game :demote, so the panel
// itself puts the account back to player when it starts.
import { Database } from "bun:sqlite";
import { makeChecker } from "../../tools/lib/harness.ts";
import { createPlayer } from "../../tools/lib/mix-client.ts";
import { openStore } from "../src/store.ts";
import { queryAudit } from "../src/audit.ts";
import { startStack } from "./lib/panel.ts";

const { check, finish } = makeChecker();
const s = await startStack(["boss@x.com", "gone@x.com"]);
const api = s.servers.api;

const usernameOf = (swid: string) => {
  const db = new Database(api.dbPath, { readonly: true });
  const r = db.query("SELECT username FROM player_identity WHERE swid = ?").get(swid) as { username: string };
  db.close();
  return r.username;
};
const roleOf = async (swid: string) => ((await (await fetch(`${api.base}/api/internal/identity`, { method: "POST", headers: api.internalHeaders(), body: JSON.stringify({ swid }) })).json()) as any).role;
const confirmAndPost = async (path: string, fields: Record<string, string>) => {
  const first = await (await s.post(path, "boss@x.com", fields)).text();
  const rev = first.match(/name="rev" value="([^"]*)"/)?.[1] ?? "";
  return (await s.post(path, "boss@x.com", { ...fields, rev, confirm: "1" })).text();
};
const waitFor = async (cond: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(200); }
  return false;
};

try {
  await createPlayer(api.base, api.dbPath, "{erin}", "Erin");
  const erin = usernameOf("{erin}");

  const saved = await confirmAndPost("/staff/update", { email: "gone@x.com", role: "owner", link: erin });
  check(saved.includes("Saved and synced"), "an owner row is linked to Erin");
  check((await roleOf("{erin}")) === "admin", "Erin is admin in game");

  await s.restartPanel({ PANEL_OWNERS: "boss@x.com" });
  check((await s.get("/", "gone@x.com")).status === 403, "taken out of PANEL_OWNERS: no panel access");
  check(await waitFor(async () => (await roleOf("{erin}")) === "player"), "after the restart, Erin is back to player");

  const store = openStore(s.dbPath, ["boss@x.com"]);
  const row = queryAudit(store, { action: "role.sync", target: "gone@x.com", limit: 1 })[0];
  check(row?.actor === "panel-reconcile" && row.result === "ok", "the reconcile is audited");

  const before = queryAudit(store, { action: "role.sync", limit: 50 }).length;
  await s.restartPanel();
  await Bun.sleep(1500);
  check(queryAudit(store, { action: "role.sync", limit: 50 }).length === before, "an account already at player isn't synced again");
} finally {
  await s.stop();
}
finish();
