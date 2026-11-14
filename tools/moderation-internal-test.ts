// The web API's internal moderation endpoints for the game server:
// moderation-state (bans + active mutes for who is online), mute, unmute,
// and mutedUntil on identity. All need the internal secret.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const call = (path: string, body: unknown, internal = true) =>
  fetch(`${api.base}/api/internal/${path}`, {
    method: "POST",
    headers: internal ? api.internalHeaders() : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) as any });

try {
  await createPlayer(api.base, api.dbPath, "{mi-carol}", "MiCarol");

  for (const [path, body] of [["moderation-state", { swids: [] }], ["mute", { swid: "{x}", minutes: 5, setBy: "game:x", setByRank: "admin" }], ["unmute", { swid: "{x}", by: "game:x", byRank: "admin" }]] as const) {
    check((await call(path, body, false)).status === 403, `${path} without the internal secret → 403`);
  }

  let r = await json(await call("mute", { swid: "{mi-carol}", minutes: 5, setBy: "game:Boss", setByRank: "moderator", reason: "spam" }));
  check(r.status === 200 && typeof r.body?.until === "string" && r.body.until.endsWith("Z"), `mute → {until} (${JSON.stringify(r)})`);

  r = await json(await call("moderation-state", { swids: ["{mi-carol}", "{nobody}"] }));
  check(r.status === 200 && Array.isArray(r.body?.banned) && r.body.banned.length === 0, "moderation-state: nobody banned");
  check(Object.keys(r.body?.mutes ?? {}).join() === "{mi-carol}", `moderation-state lists the mute (${JSON.stringify(r.body)})`);

  r = await json(await call("identity", { swid: "{mi-carol}" }));
  check(typeof r.body?.mutedUntil === "string", `identity has mutedUntil while muted (${JSON.stringify(r.body)})`);

  for (const minutes of [0, 10081, 1.5, "5", null]) {
    const bad = await call("mute", { swid: "{mi-carol}", minutes, setBy: "game:Boss", setByRank: "moderator" });
    check(bad.status === 400, `mute with minutes ${JSON.stringify(minutes)} → 400 (${bad.status})`);
  }
  for (const body of [{ swid: 5, minutes: 5, setBy: "x", setByRank: "admin" }, { swid: "{a}", minutes: 5, setBy: "", setByRank: "admin" },
    { swid: "{a}", minutes: 5, setBy: "x", setByRank: "owner" }, { swid: "{a}", minutes: 5, setBy: "x", setByRank: "admin", reason: "r".repeat(501) }]) {
    check((await call("mute", body)).status === 400, `mute with ${JSON.stringify(body).slice(0, 60)} → 400`);
  }
  check((await call("moderation-state", { swids: "nope" })).status === 400, "moderation-state with bad swids → 400");

  r = await json(await call("mute", { swid: "{mi-carol}", minutes: 5, setBy: "game:Admin", setByRank: "admin" }));
  const over = await json(await call("mute", { swid: "{mi-carol}", minutes: 1, setBy: "game:Mod", setByRank: "moderator" }));
  check(over.status === 403 && over.body?.error === "rank", `a moderator can't replace an admin's mute (${JSON.stringify(over)})`);
  const refused = await json(await call("unmute", { swid: "{mi-carol}", by: "game:Mod", byRank: "moderator" }));
  check(refused.status === 403 && refused.body?.error === "rank", `a moderator can't lift an admin's mute (${JSON.stringify(refused)})`);
  r = await json(await call("unmute", { swid: "{mi-carol}", by: "game:Admin", byRank: "admin" }));
  check(r.status === 200 && r.body?.lifted === true, "unmute by an admin → lifted");
  r = await json(await call("unmute", { swid: "{mi-carol}", by: "game:Admin", byRank: "admin" }));
  check(r.status === 200 && r.body?.lifted === false, "unmute with no mute → lifted false");

  r = await json(await call("identity", { swid: "{mi-carol}" }));
  check(r.body?.mutedUntil === null, "identity mutedUntil null after the lift");
  r = await json(await call("banned", { swids: ["{mi-carol}"] }));
  check(r.status === 200 && Array.isArray(r.body?.banned), "the old /api/internal/banned still answers");
} finally {
  await api.stop();
}
finish();
