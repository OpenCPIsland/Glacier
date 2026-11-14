# tools

Test scripts for `web-api` and `smartfox-server`. Each one starts a throwaway copy of the web
API with its own empty database (`lib/harness.ts`), so your real
`cpi_data.db` is never touched. Run them from the repo root with Bun.
Each prints `PASS`/`FAIL` lines and ends with `ALL PASSED` (exit 0) or
`N FAILURE(S)` (exit 1).

```sh
for t in tools/*-test.ts; do bun "$t" || break; done
```

| Script | What it checks |
|---|---|
| `mix-friends-test.ts` | Mix friend invites, accept, remove, trust and cancel. Every notification follows the client's strict "latest + 1" sequence rule. |
| `webapi-fixes-test.ts` | `X-HTTP-Method-Override` routing, the invitations table migration, and online/offline session handling. |
| `tube-equip-test.ts` | The equipped tube is stored and comes back as `selectedTubeId` on every room join; unknown tube ids are refused. |
| `room-version-test.ts` | Rooms are split by the X-CP-Client-Version header: signed room names, igloos, room list, populations and player cards carry the caller's version (malformed or missing gives the default), and players of different versions never share a game-server room. |
| `room-cap-test.ts` | Room cap in the web API: population bars scaled to `ROOM_CAP`; a full room or igloo refuses joins with `409 {code:1000}`, while re-joins, moderators, admins and igloo owners get in; a double join counts once and stale unconfirmed joins stop counting; rooms are per client version; a room-full retry gets the first world with space and `[]` when every world is full; a player's earlier unconfirmed joins stop counting but count again if their token connects; oversized `worlds`/`rooms` filters are deduped and capped. |
| `room-cap-backstop-test.ts` | The game server's room ceiling: a login past `ROOM_CAP + ROOM_CAP_HEADROOM` gets SFS join error 20 with the room name (the client's wire layout), is never placed in the room or shown to its players, is closed, and its web API session ends; the refusal makes the web API treat the room as full (so the room-full retry can't loop back into it); other rooms still take logins. |
| `session-heartbeat-test.ts` | Live sessions stay counted however long they last: `POST /api/internal/sessions-alive` refreshes confirmed sessions only (internal secret, integer ids, at most 10,000), a 13-hour session reported alive still fills its room, and the game server reports its connected players on its own. |
| `room-index-test.ts` | The game server's per-room session index in-process: lookups in registration order, occupancy, the room recorded at register, and emptied rooms leave nothing behind. |
| `world-population-test.ts` | The client's servers (worlds): a join without a world lands in the first listed world (Iceberg), populations count the players in each world and room (not an even split of the room total), worlds outside the known five are listed once someone is in them, populations cover the client's real zones, and world, language and room names containing `:` or `;`, control characters or over 40 characters are refused. |
| `world-rooms-test.ts` | Worlds on the game server: players in different worlds never share a room, and a world other than Alpine joins and connects like any other. |
| `igloo-owner-test.ts` | `room.igloo_updated` ownership: the room's world must be `Igloo` and its instance exactly the sender's swid; a swid that merely appears in a world, language or room name is not ownership. |
| `mix-session-test.ts` | Mix login, the RSA→AES session, encrypted `/state`, and an invite delivered through a poll the way the SDK polls. |
| `mix-auth-test.ts` | Mix requests act only as the token's user: bogus tokens, forged `UserId` and foreign sessions get the SDK's 401 statuses. |
| `mix-security-test.ts` | Only the invitee can accept a friendship, with the invitation's trust; a rename can't redirect an invitation; display-name rules; a ban blocks CPI calls made with an existing token. |
| `mix-game-state-test.ts` | Answering a game posted in a Mix chat (`POST /chatThread/gameStateMessage`): the answer joins the game's state and becomes its own message, both players are told in the order the app expects, a second answer replaces the first, retries change nothing, answers for someone else or from outside the thread are refused, and `/state` lists games that changed while a client was away. |
| `mix-boot-test.ts` | The cpipe manifest (`GET /cpipe`) and files (`GET /cpipe/files/...`), including path traversal rejection. |
| `mix-content-test.ts` | Desktop bundle entries in the cpipe manifest (CRC32, mtime version, no `.meta`), serving them, and the base manifest when no bundles are installed. |
| `mix-config-test.ts` | The boot config tool round-trips, and `openssl` decrypts what it writes. |
| `webapi-auth-test.ts` | CPI access-token auth with default settings: valid tokens work, while expired, unknown or raw-SWID tokens get 401 and never create accounts. |
| `party-games-data-test.ts` | Party game definitions from `smartfox-server/data/party-games.json`: rules, trigger props, placement rewards. |
| `party-games-manager-test.ts` | The party game manager in-process: `pgame.start.v2` / `pgame.message` / `pgame.end` reach only the players, the game prop is shown to the room, rewards are granted and sent as `reward.add_delayed`, and bad messages are ignored. |
| `party-games-findfour-test.ts` | Find Four rules in-process: turn order, column fixes, wins in every direction, draws, the turn timeout and forfeits. |
| `party-games-fishbucket-rules-test.ts` | Fish Bucket rules, pure: deck per player count from the game data, seeded shuffles, the clamp at 0 and dense placements. |
| `party-games-fishbucket-test.ts` | The Fish Bucket session in-process: positions relay, turn order, draw/pass/squid delays, the turn timeout, deck exhaustion, ties, quitting and disconnects, wire types, action-byte logging. |
| `party-games-fishbucket-invitation-test.ts` | The owner-start invitation end to end: 3 guest slots, Start with and without guests, cancelling during the handoff, a guest leaving, and a full invitation starting by itself. |
| `party-games-fishbucket-e2e-test.ts` | Fish Bucket end to end with 3, 2 and 3-with-a-disconnect players: a driver plays by the rules, then scores recomputed from the cards must match the placements and the coins in the web API. |
| `auth-hardening-test.ts` | Guest login and registration: only issued API keys, password length, 210,000-round hashes (old ones still log in and are upgraded), no claiming password-less accounts, and per-address rate limits. |
| `held-item-echo-test.ts` | A player holding a tray or a taken item who changes their own `con` never makes any client add a second held item (taking a slice, eating it, then pulling out something else; re-sending the same tray). |
| `post-deploy-fixes-test.ts` | Fixes from the first deployed server: `tcpPort` is a number when `GAME_SERVER_PORT` is set; login, refresh and validate errors use codes the client maps (wrong password, lockout, bad refresh token, size errors); each client gets its own random API key, and display-name validate doesn't call the caller's own name taken; a forged `quest.set` pays nothing; no `X-Powered-By`. |
| `connection-limits-test.ts` | Game server connection limits: no login within the timeout, silence after login (pings keep it open), the overall cap, the per-address connect rate, and per-address limits behind a proxy (`SFS_TRUST_PROXY`). |
| `rate-limit-test.ts` | The rate limiter in-process: `TRUST_PROXY` reads the proxy-appended address, not one the client wrote; IPv6 is limited per /64; the address table stays bounded. |
| `name-rules-test.ts` | The shared username/display-name rule (`web-api/src/utils/names.ts`): emoji, rich-text tags, invisible and control characters, look-alike alphabets, padding and Unicode folding are refused on registration, profile updates and both renames. |
| `staff-roles-webapi-test.ts` | Staff roles in the web API: `STAFF_ADMINS` (exact names, so a look-alike account isn't an admin), `players.role`, and the internal identity / set-role endpoints. |
| `staff-unit-test.ts` | Staff command pieces in-process: what counts as a command (emoticons don't), roles before the account lookup answers, mutes at reconnect, the restart countdown schedule. |
| `realtime-trust-test.ts` | What the game server takes from a client: nothing is handled before login, deeply nested packets are refused, the name others see is the signed one (a forged `un` or edited `joinRoomData` doesn't change it), malformed outfit/colour/tube variables aren't relayed, and banned accounts are refused at login and closed while online. |
| `token-storage-test.ts` | Login tokens are stored as SHA-256 hashes, never in plain text, and tokens stored in plain text by an older version are hashed at the next start without ending the session. |
| `game-api-limit-test.ts` | Game API call limits per account and per address (429 past them), other accounts and routes outside the game API unaffected, normal use far below the defaults. |
| `single-session-test.ts` | A second login for the same account closes the older connection; other accounts are untouched and the account stays online. |
| `appearance-trust-test.ts` | Colour, tube and outfit shown to others are the web API's saved values: an honest login causes no correction, an edited `joinRoomData` is corrected, variables a client sets are not relayed as sent, and a real saved change is. |
| `webapi-limits-test.ts` | Web API input limits: name and online lookups take at most 500 strings, a body announced as encrypted is capped at 1 MB (with or without a length), breadcrumb and tutorial ids are validated, the database file is mode 600, and client values in these routes are logged on one line. |
| `staff-commands-test.ts` | Staff chat commands end to end with signed logins: rewards follow the signed swid not the login name, every command, role limits, mutes, `:admin-alert` popups and a real `:admin-swre-restart` under the supervisor. Sections can be run on their own (`bun tools/staff-commands-test.ts economy`). |
| `party-games-test.ts` | Find Four end to end with a game server and three clients: the invitation, joining, a full match with coin rewards in the web API, and a forfeit by disconnect. |
| `party-games-room-items-test.ts` | Room MMO items for party games in-process: an added item and its variables reach everyone in the room (not other rooms), a change sends only the changed variable, removal sends the id, and joiners get a snapshot. |
| `party-games-dance-rules-test.ts` | Dance Battle rules, pure: per-player and team scoring, the emote each move plays (failure move for misses), per-round sequence sets from the game data, win/tie/placement and the "nobody scored, nobody paid" rule. |
| `party-games-lobby-test.ts` | Scheduled party-game lobbies in-process: lobby windows end on the 6-minute boundary, team/role slots, joining by interacting with the lobby item, leaving, the 20-player cap, cancel with too few players or one team, and an emptied room dropping its lobby. |
| `world-objects-data-test.ts` | `smartfox-server/data/world-objects.json` (Disney's ScheduledWorldObjects and IslandTargets data): only the Boardwalk geysers and the Mt Blizzard playground, 7 supersets / 29 phases / 106 targets, the rewards, path nesting, scale-corrected radii, no local paths. |
| `world-data-test.ts` | The data loader and picker in-process: a missing or broken file leaves empty data without crashing, date windows, the room's content date, and the ordered / random / non-repeating picks. |
| `party-calendar-test.ts` | Party calendar rules, pure: start inclusive, end exclusive, a range wrapping the new year, overlaps, `calendar: false`, the three override modes and validation of the data file. |
| `party-api-test.ts` | The party routes on a throwaway web API: public schedule JSON and cache header, internal routes refused without the secret, the override round trip and surviving a restart, a removed party, and the mapping file staying a 404 while the CDN is off. |
| `cdn-manifest-test.ts` | The island client's CDN boot files, pure: exact mapping, manifest and directory bodies, the hash names, validation (version equality as the client's `System.Version` sees it, platforms, limits), and ports of the client's `IsEqualTo` and `getFullAssetUrl`. |
| `cdn-routes-test.ts` | The three CDN routes on a throwaway web API: 404 while off or when the stored value is bad, the mapping → manifest → directory chain, old hashes and other hosts' hashes 404, and the client's matching rules run on the served directory. |
| `cdn-seed-test.ts` | `cdn-seed-versions.ts` against a throwaway git repo: latest content version per client version, platform filter, CLI output and exit codes, and that it only prints. |
| `cdn-release-test.ts` | Importing a CDN content release (an Addressables update build's platform folders, or the client generator's `Export/www` tree): only `.unity3d` files under `ClientBundles` are kept, CRC32s, the manifest bundle per platform from `ClientManifestDirectory.json`, immutable ids, refusals leave nothing behind, safe file lookup, and the `cdn-import-release.ts` CLI. |
| `../admin-panel/tests/webapi-cdn-release-test.ts` | Content releases through the real web API: rows naming a missing release are refused, the manifest lists the release's bundles, bundles are served byte for byte (ranged too, empty 404 for anything unlisted or traversal), and stay served while the switch is off. |
| `party-cache-test.ts` | The game server's party cache against a stub: fails closed, keeps the last state, one log line per outage. |
| `party-command-test.ts` | `:admin-party` end to end: permissions, replies, name/id/key forms, usage and the logged override. |
| `world-objects-test.ts` | The Boardwalk geysers in-process: one active at a time, the next every 17 s without repeats, late joiners get each item's real transition time, other zones get nothing, and an emptied room stops its timers. |
| `island-targets-rules-test.ts` | Island Targets rules, pure: hit points, the reward split and its minimum, the clock tower's next start, throw guards (rate, speed, drift, no known position) and the snowball trajectory test. |
| `island-targets-e2e-test.ts` | Crate Co end to end: `:crateco`, the group/target/stats wire, aimed throws counted and guarded ones logged, rounds advancing, a late joiner's snapshot, the final win's reward and streak, a timeout, a hit landing too late, and an emptied room. `TARGETS_E2E_LOG=<file>` keeps the game server log. |
| `island-targets-log-test.ts` | A player name with a newline or escape codes can't forge or break an Island Targets `[TARGETS]` log line (logSafe), and a flood of dropped throws logs at most one line a second. |
| `island-targets-rewards-test.ts` | Island Targets payouts in-process: one account with two sessions is paid once and the share is split by paid accounts; no session id or no verified account doesn't dilute it; an account paid in one room isn't paid again in another that window; a joiner in a won round's linger gets no live group. |
| `party-games-dance-test.ts` | The Dance Battle session in-process (2 v 2 and a spectator): item and prop/pose lifecycle, junk input ignored, dance outcomes, team-mean scores over 4 rounds, placements and rewards, AFK match pays nothing, a team walking out only pays if the winners scored, quitting by putting the prop away. |
| `party-games-dance-e2e-test.ts` | Dance Battle end to end with a real web API and game server: `:dancebattle`, four players join by interaction, the game runs, the spectator sees it, placements and coin rewards land in the web API, and a new lobby can open. |
| `consumable-signature-test.ts` | Consumable spend verification: the web API signs uses and refuses them without stock; the game server plays `con.use` only with a signed, unused spend for that player; `con.partial` is signed and the web API stores only signed partials. Covers tampering, replay, another player's payload and non-canonical signatures. |
| `internal-bridge-test.ts` | The internal bridge between the servers: the shared secret is always required (set or derived from the join key), proxied requests are refused, the web API's notifier sends the secret to `SFS_NOTIFY_PORT`, and `HOST` / `SFS_BIND_HOST` / the notify port keep listeners on localhost. |
| `log-hygiene-test.ts` | Client text can't forge or flood the web API log (escaped, length- and count-capped), the logged address isn't a client-written header, and error responses carry no stack traces or echoed URLs. |
| `anonymous-access-test.ts` | Without a login the CPI game API answers 401 `{code: 3}` instead of acting as a shared fallback account; only the calls the client makes without credentials (other-player lookups, the encryption key, diagnostics) stay open. |
| `economy-test.ts` | Requests can't name their own rewards; counts can't go negative and purchases need the coins (Coins for Change, Disney store, igloo decorations); quests pay only for defined quests with every objective recorded; room collectibles pay once per respawn by the server's clock; unknown reward ids grant nothing; one player can't overwrite another's item or igloo layout; making clothing costs the template's coins; the catalog pays once per theme and checks the buyer's coins; the quick-notification reward is daily and the daily spin once a day; a fishing catch must be a prize from your own last cast; only consumables the game sells can be bought, at their real price. |
| `token-test.ts` | Guest Controller tokens: an access token only works as one (game API, bearer, Mix) and a refresh token only refreshes; a used refresh token stops working; no token reaches the log. |

`lib/harness.ts` exports `startWebApi()` (copy, start, `restart`,
`stop`, `logs`) and `makeChecker()` (`check` and `finish`).
`lib/sfs-client.ts` exports `startGameServer()` and `GameClient`, a fake
SFS2X client that logs in with signed joinRoomData and spends consumables
through the web API.

## Checking existing names

`check-names.ts` lists usernames and display names that break the name
rule (`web-api/src/utils/names.ts`), and names that clash ignoring case.
The rule only applies to names set from now on, so run this on a database
from before it. Read-only; exit code 1 when anything is found.

```sh
bun tools/check-names.ts --db web-api/src/cpi_data.db
```

## Mix boot config

`mix-config.ts` writes the encrypted config the Disney Mix app reads at
boot (`StreamingAssets/donotcopy/n7c4c656`), pointing all of its
services at your server:

```sh
bun tools/mix-config.ts render http://192.168.1.50:3000 --out n7c4c656
bun tools/mix-config.ts decrypt n7c4c656     # inspect any config, including Disney's
```

`lib/mix-client.ts` is a test client that behaves like the Mix SDK
(login, key exchange, encrypted bodies, strict notification order). Use
it for any new Mix test.

## Mix content (stickers, gags, games)

`mix-content.ts` fills the git-ignored bundle tree that `/cpipe` lists
for desktop source builds of Mix (docs/MIX_API.md sections 2 and 10):

```sh
bun tools/mix-content.ts build --project ~/src/DisneyMix     # Linux bundles via Unity batchmode (~3 min)
bun tools/mix-content.ts import --from ~/src/DisneyMix/Assets/StreamingAssets/AssetBundles
```

It copies `windows64` and `standalonelinux64` bundles into
`web-api/data/mix/cpipe/AssetBundles/` and prints what's present against
Disney's final manifest. Restart web-api afterwards.

## CDN version rows

`cdn-seed-versions.ts` reads a client repo's git history and prints the
rows (client version, platform, embedded content version) for the admin
panel's CDN page. It only prints; paste the output into the page's import
box, review, and confirm:

```sh
bun tools/cdn-seed-versions.ts <client repo> [--platforms=standalonewindows64,standaloneosx]
```

## CDN content releases

A content release is a set of Addressables bundles that players download
instead of their embedded copies. Build it with the client's
`Project > AssetBundles > Generated > Generate CDN AssetBundles` Steps 1-4,
then import the `Export/www` folder it leaves:

```sh
bun tools/cdn-import-release.ts <release folder> <release-id> [releases-dir]
```

`releases-dir` defaults to `$CDN_RELEASES_DIR`, then `web-api/data/cdn-releases`.
A release id is immutable once imported. Then give a CDN row that release id;
rows without one stay embedded. Release files are served from
`/cdn.disney.io/<release-id>/<Platform>/<file>` (an Addressables update build: one
folder per Unity build target, each with `catalog_<version>.bin|json`, its `.hash` and
`.bundle` files) or `/cdn.disney.io/<release-id>/ClientBundles/...` (the older
manifest-bundle layout). Anything else under `/cdn.disney.io` is an empty 404,
because the client caches any body it is given.
