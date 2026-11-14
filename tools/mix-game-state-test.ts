// Mix chat games (services/mixChat.ts): POST /chatThread/gameStateMessage,
// the call a friend's app makes when they answer a game posted in a chat
// (a Runner score, a Secret Word guess). alice-bob are friends in a 1:1;
// carol is not in the thread.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({
  env: { ALLOW_SWID_AUTH: "1" },
  // Filter rules for the moderation checks (creating the table skips the starter list).
  beforeStart: (dbPath) => {
    const d = new Database(dbPath);
    d.exec(`CREATE TABLE IF NOT EXISTS mix_moderation_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL,
      kind TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    d.run("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES ('darn', 'word', 'mask'), ('heck', 'word', 'block')");
    d.close();
  },
});
const { check, finish } = makeChecker();

// The app's shapes: State and Payload are JSON objects whose "GameData" is
// itself a JSON string (GameManager.PostGameStateData / PostGameEventData).
const wrap = (o: object) => JSON.stringify({ GameData: JSON.stringify(o) });
const gameData = (state: string) => JSON.parse(JSON.parse(state).GameData);

try {
  const users: Record<string, MixClient> = {};
  for (const [swid, name] of [["{GAME-A}", "alice"], ["{GAME-B}", "bob"], ["{GAME-C}", "carol"]] as const) {
    await createPlayer(api.base, api.dbPath, swid, name);
    const c = new MixClient(api.base);
    await c.login(name, `pw-${name}`);
    await c.startSession();
    await c.state();
    users[name] = c;
  }
  const A = users.alice!, B = users.bob!, C = users.carol!;
  const inv = await A.call("PUT", "/friendship/invitation", { InviteeDisplayName: "bob", IsTrusted: true });
  A.apply(inv.body.Notification, "AddFriendshipInvitation");
  const incoming = (await B.drain()).find((g) => g.type === "AddFriendshipInvitation")!.n;
  const acc = await B.call("PUT", "/friendship", { InvitationId: incoming.Invitation.FriendshipInvitationId, IsTrusted: true });
  B.apply(acc.body.Notification, "AddFriendship");
  await A.drain();

  const made = await A.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{GAME-B}"] });
  A.apply(made.body.Notification, "AddChatThread");
  const thread = made.body.Notification.ChatThread.ChatThreadId as number;
  await B.drain();

  // alice posts a Runner game with her own run in it.
  const aliceRun = { PlayerSwid: "{GAME-A}", Attempts: 1, Checkpoints: 3, Ghost: [] };
  const posted = await A.call("PUT", "/chatThread/gameStateMessage", {
    ChatThreadId: thread, ClientChatMessageId: 1, GameName: "runner",
    Payload: wrap({ Entitlement: "runner", Status: 2, Type: 0, Difficulty: 1, LevelData: ["a", "b"], GameCreatorGemCount: 4, Responses: [aliceRun] }),
  });
  check(posted.http === 200 && A.apply(posted.body.Notification, "AddChatThreadGameStateMessage"), `alice posts a game -> ${posted.http}`);
  const gameId = posted.body.Notification.Message.ChatMessageId as number;
  await B.drain();

  // bob plays it and answers.
  const bobRun = { PlayerSwid: "{GAME-B}", Attempts: 1, Checkpoints: 5, Ghost: [{ GhostDataType: 0, Ticks: 12, Position: "1,2" }] };
  const bobPayload = wrap(bobRun);
  const upd = await B.call("POST", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 2, GameStateMessageId: gameId, Payload: bobPayload });
  const un = upd.body?.UpdateGameStateNotification;
  const evs = upd.body?.GameEventNotifications;
  check(upd.http === 200 && upd.body?.Status === "OK" && !!un && Array.isArray(evs) && evs.length === 1, `bob answers the game -> ${upd.http} ${JSON.stringify(upd.body)?.slice(0, 200)}`);
  // ChatMessageSender queues the events first, then the update.
  check(!!evs?.[0] && B.apply(evs[0], "AddChatThreadGameEventMessage") && !!un && B.apply(un, "UpdateChatThreadGameStateMessage"), "bob's reply notifications are his next two sequences, event first");
  const ev = evs?.[0]?.Message;
  check(ev?.MessageType === "GAME_EVENT" && ev?.GameStateMessageId === gameId && ev?.GameName === "runner" && ev?.Payload === bobPayload
    && ev?.SenderUserId === "{GAME-B}" && ev?.SequenceNumber === 2 && ev?.ChatThreadId === thread && ev?.ClientChatMessageId === 2, `the event is bob's answer as sent, the thread's next message (${JSON.stringify(ev)?.slice(0, 160)})`);
  const um = un?.Message;
  check(um?.ChatMessageId === gameId && um?.MessageType === "GAME_STATE" && um?.GameName === "runner" && um?.SenderUserId === "{GAME-A}" && um?.SequenceNumber === 1
    && typeof un?.Result === "string", "the update carries the original game message (alice's, still sequence 1) and a Result");
  const merged = um?.State ? gameData(um.State) : null;
  check(merged?.Responses?.length === 2 && merged.Responses[0].PlayerSwid === "{GAME-A}" && merged.Responses[1].PlayerSwid === "{GAME-B}" && merged.Responses[1].Checkpoints === 5
    && merged.Responses[1].Ghost?.[0]?.Position === "1,2", `the game's state now holds both runs (${merged?.Responses?.length})`);
  check(merged?.Difficulty === 1 && merged?.GameCreatorGemCount === 4 && JSON.stringify(merged?.LevelData) === '["a","b"]' && merged?.Entitlement === "runner", "the rest of the game's data is unchanged");

  const aGot = await A.drain();
  check(aGot.map((g) => g.type).join() === "AddChatThreadGameEventMessage,UpdateChatThreadGameStateMessage", `alice hears the answer and the update (${aGot.map((g) => g.type).join()})`);
  check(aGot[1]?.n?.Message?.State === um?.State && aGot[0]?.n?.Message?.ChatMessageId === ev?.ChatMessageId, "alice gets the same state and event as bob");

  // bob plays again: his run is replaced, not added twice (the app reads a
  // player's first response, MixGameData.GetMyResponse).
  const again = await B.call("POST", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 3, GameStateMessageId: gameId, Payload: wrap({ ...bobRun, Attempts: 2, Checkpoints: 9 }) });
  B.apply(again.body.GameEventNotifications[0], "AddChatThreadGameEventMessage"); B.apply(again.body.UpdateGameStateNotification, "UpdateChatThreadGameStateMessage");
  const merged2 = gameData(again.body.UpdateGameStateNotification.Message.State);
  check(again.http === 200 && merged2.Responses.length === 2 && merged2.Responses[1].PlayerSwid === "{GAME-B}" && merged2.Responses[1].Attempts === 2 && merged2.Responses[1].Checkpoints === 9, `bob's second run replaces his first (${merged2.Responses.length} responses)`);
  check(again.body.GameEventNotifications[0].Message.SequenceNumber === 3, "and is the thread's third message");
  await A.drain();

  // A retry of the same request changes nothing and returns the same reply.
  const retry = await B.call("POST", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 3, GameStateMessageId: gameId, Payload: wrap({ ...bobRun, Attempts: 2, Checkpoints: 9 }) });
  check(retry.http === 200 && retry.body.GameEventNotifications?.[0]?.SequenceNumber === again.body.GameEventNotifications[0].SequenceNumber
    && retry.body.UpdateGameStateNotification?.SequenceNumber === again.body.UpdateGameStateNotification.SequenceNumber
    && retry.body.GameEventNotifications[0].Message.ChatMessageId === again.body.GameEventNotifications[0].Message.ChatMessageId, "a retry returns the original notifications");
  check((await A.drain()).length === 0 && (await B.drain()).length === 0, "and sends nothing new");

  // Refused.
  const bad = async (who: MixClient, body: object) => { const r = await who.call("POST", "/chatThread/gameStateMessage", body); return `${r.http} ${r.body?.Status}`; };
  let cid = 100;
  const base = () => ({ ChatThreadId: thread, ClientChatMessageId: cid++, GameStateMessageId: gameId, Payload: bobPayload });
  const r1 = await bad(C, { ...base(), Payload: wrap({ PlayerSwid: "{GAME-C}" }) });
  check(r1 === "400 NOT_FOUND", `carol (not in the thread) -> ${r1}`);
  const r2 = await bad(B, { ...base(), GameStateMessageId: 999999 });
  check(r2 === "400 NOT_FOUND", `an unknown game message -> ${r2}`);
  const r3 = await bad(B, { ...base(), GameStateMessageId: ev.ChatMessageId });
  check(r3 === "400 NOT_FOUND", `a message that isn't a game -> ${r3}`);
  const r4 = await bad(B, { ...base(), Payload: wrap(aliceRun) });
  check(r4 === "400 INVALID_REQUEST", `bob answering as alice -> ${r4}`);
  const r5 = await bad(B, { ...base(), Payload: "not json" });
  check(r5 === "400 INVALID_REQUEST", `a payload that isn't JSON -> ${r5}`);
  const r6 = await bad(B, { ...base(), Payload: JSON.stringify({ GameData: "[1]" }) });
  check(r6 === "400 INVALID_REQUEST", `game data that isn't an object -> ${r6}`);
  const r7 = await bad(B, { ...base(), ClientChatMessageId: "x" });
  check(r7 === "400 INVALID_REQUEST", `a bad client message id -> ${r7}`);
  check((await A.drain()).length === 0, "refused answers notify nobody");

  // Game text is filtered like chat text, in posts and in answers.
  const word = await A.call("PUT", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 200, GameName: "secretword",
    Payload: wrap({ Entitlement: "secretword", Word: "apple", Hint: "a darn fruit", Responses: [] }) });
  check(word.http === 200 && A.apply(word.body.Notification, "AddChatThreadGameStateMessage") && gameData(word.body.Notification.Message.State).Hint === "a **** fruit"
    && gameData(word.body.Notification.Message.State).Word === "apple", `a masked word in a posted game is starred (${word.http})`);
  const wordId = word.body.Notification.Message.ChatMessageId as number;
  const rude = await A.call("PUT", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 201, GameName: "secretword",
    Payload: wrap({ Entitlement: "secretword", Word: "apple", Hint: "what the heck", Responses: [] }) });
  check(rude.http === 400 && rude.body?.Status === "MODERATION_BLOCKED", `a blocked word in a posted game -> ${rude.http} ${rude.body?.Status}`);
  await B.drain();
  const masked = await B.call("POST", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 202, GameStateMessageId: wordId,
    Payload: wrap({ PlayerSwid: "{GAME-B}", Attempts: 1, Success: true, Note: "darn easy" }) });
  const mEv = masked.body?.GameEventNotifications?.[0];
  check(masked.http === 200 && B.apply(mEv, "AddChatThreadGameEventMessage") && B.apply(masked.body.UpdateGameStateNotification, "UpdateChatThreadGameStateMessage")
    && gameData(mEv.Message.Payload).Note === "**** easy" && gameData(masked.body.UpdateGameStateNotification.Message.State).Responses[0].Note === "**** easy"
    && gameData(mEv.Message.Payload).Success === true, `a masked word in an answer is starred in the event and the state (${masked.http})`);
  const blocked = await bad(B, { ChatThreadId: thread, ClientChatMessageId: 203, GameStateMessageId: wordId, Payload: wrap({ PlayerSwid: "{GAME-B}", Note: "heck" }) });
  check(blocked === "400 MODERATION_BLOCKED", `a blocked word in an answer -> ${blocked}`);
  const deep = await bad(B, { ChatThreadId: thread, ClientChatMessageId: 204, GameStateMessageId: wordId, Payload: wrap({ PlayerSwid: "{GAME-B}", Deep: JSON.parse("[".repeat(20000) + "]".repeat(20000)) }) });
  check(deep === "200 OK" || deep === "400 INVALID_REQUEST", `very deeply nested answer data is answered, not a crash -> ${deep}`);
  await A.drain(); await B.drain();

  // History has the current state and both events.
  const hist = await A.call("POST", "/chatThread/messages/bySequenceRange", { ChatThreadId: thread, Ranges: [1, 3] });
  check(hist.http === 200 && hist.body.GameState.length === 1 && gameData(hist.body.GameState[0].State).Responses[1].Checkpoints === 9
    && hist.body.GameEvent.length === 2 && hist.body.GameEvent.every((m: any) => m.GameStateMessageId === gameId && m.GameName === "runner" && typeof m.Payload === "string"), `history: ${hist.body?.GameState?.length} game with the latest state, ${hist.body?.GameEvent?.length} events`);

  // /state lists games changed since the client last heard anything.
  const created = posted.body.Notification.Message.Created as number;
  const st = await A.call("POST", "/state", { GameStateSince: created - 1 });
  check(st.http === 200 && st.body.GameStateChatMessages.length === 2 && st.body.GameStateChatMessages[0].ChatMessageId === gameId && st.body.GameStateChatMessages[0].ChatThreadId === thread
    && gameData(st.body.GameStateChatMessages[0].State).Responses.length === 2, `/state since before the answers lists the game (${st.body?.GameStateChatMessages?.length})`);
  const stLater = await A.call("POST", "/state", { GameStateSince: Date.now() + 60_000 });
  check(stLater.body.GameStateChatMessages.length === 0, "/state since later lists none");
  const stNone = await A.call("POST", "/state", {});
  check(stNone.body.GameStateChatMessages.length === 0, "/state without GameStateSince lists none");
  const stCarol = await C.call("POST", "/state", { GameStateSince: 0 });
  check(stCarol.body.GameStateChatMessages.length === 0, "carol's /state doesn't list other people's games");

  // A retry after the stored notifications were cleaned up is rebuilt, for
  // someone still in the thread.
  const d = new Database(api.dbPath);
  d.run("DELETE FROM mix_pending_notifications WHERE swid = '{GAME-B}'");
  d.close();
  const late = await B.call("POST", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: 3, GameStateMessageId: gameId, Payload: wrap({ ...bobRun, Attempts: 2, Checkpoints: 9 }) });
  check(late.http === 200 && late.body.UpdateGameStateNotification?.Message?.ChatMessageId === gameId && late.body.GameEventNotifications?.[0]?.Message?.SequenceNumber === 3
    && typeof late.body.UpdateGameStateNotification.SequenceNumber === "number", `a late retry is rebuilt -> ${late.http}`);
  check((await A.drain()).length === 0, "and still sends nothing new");
} finally {
  api.stop();
}
finish(api.logs());
