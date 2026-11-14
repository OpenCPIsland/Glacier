# Iceberg admin panel

Staff-only panel for the game server, web API and content. It has three
parts:

- `admin-panel/`: the panel service (Bun, server-rendered HTML, its own
  SQLite database for the staff list and the audit log).
- `web-api/src/admin/`: a module the web API loads with Bun's preload. It
  serves a signed admin listener on 127.0.0.1:8091 and installs the role
  lock in the game database.
- `smartfox-server/src/admin/`: the same for the game server, on
  127.0.0.1:8092.

Nothing in iceberg imports these modules. A server only loads its admin
module when its env file sets `BUN_OPTIONS=--preload=...`, so a server
without that line runs as plain iceberg.

## Security model

The code is public. Nothing here depends on it being secret:

- **Cloudflare Access** in front of the panel (via a Cloudflare Tunnel; the
  panel binds 127.0.0.1:8090 only). The panel checks the Access JWT itself
  on every request (signature, issuer, audience, expiry), so a request
  that didn't pass Access is refused even from the box.
- **Staff list** in the panel's database: a valid Access identity that
  isn't an enabled staff row gets 403. Roles: moderator, admin, owner,
  checked against one permission table (`shared/permissions.ts`).
- **CSRF**: every POST needs the panel's own Origin and an HMAC token.
- **Signed calls** from the panel to the two admin listeners: HMAC over
  method, path, body, actor, role, action, timestamp and nonce; loopback
  only, replays and proxied requests refused. Each listener re-checks the
  permission table.
- **Role lock**: a SQLite trigger (`admin_role_lock`) in the game database,
  so the in-game role of a panel-linked account can only be changed by the
  panel.
- **Audit log**: append-only and hash-chained; each new row's id and hash
  also goes to the journal, which the panel's user can't edit.

Per-server moderation settings (word lists, thresholds, detection tuning)
are data in each server's database or config, never in this code.

The **CDN page** (admins view, owners edit) switches the island client's CDN boot files on and lists the client builds they're served for. Builds not on the list get the forced-upgrade screen, so a change goes through a dry run and a confirm page, and turning the CDN off fixes it on the next boot.

Before the first switch-on, check from outside the box that the URL the manifest advertises works: fetch `/__mapping_cpremix_prod.json` and then the manifest it names with the public host, and open the directory URL its `cdnRoot` produces. A wrong scheme or host there (a proxy that doesn't forward `X-Forwarded-Proto` or `Host`) would send every listed build to the forced-upgrade screen until the CDN is turned off.

Deployment: [DEPLOY.md](DEPLOY.md). Tests: `bash admin-panel/tests/run-all.sh`.

## Moderation (sub-project 2a)

Pages (each hidden from roles that can't use it, and refused server-side):

- **Home**: player search, live tiles (online, open reports, active mutes,
  active bans), rooms by world, recent staff actions (admin and up). The
  live values come from one shared poller (`src/live.ts`) that runs only
  while someone watches and cuts off staff who lose access.
- **Players**: who is online, search, and a player page with History,
  Reports and Notes tabs. Actions: kick, mute, lift mute, warn, ban, lift
  ban. Each needs a reason (1-500 characters, from a template chip plus an
  optional note), shows what will happen, and writes one audit row
  (`ok`, `partial` when only the live effect was missed, `denied`, `failed`).
- **Reports**: queue with filters; resolve with a reason, or act on the
  player from the report (the action resolves it).
- **More**: word filter and reason templates (admin and up), Staff, CDN,
  Audit log, Me.

Rules that hold even if the panel is bypassed (both listeners repeat them):
the target's in-game role must be below the actor's panel rank, never the
actor's own linked account, moderators ban for at most 72 hours and never
permanently, a lifted mute needs at least the setter's rank, lifting a ban
someone else set needs `ban.lift.any`.

Where data lives: bans, mutes, reports, sanctions and the word filter in
the web API database; staff, audit, notes and reason templates in the
panel's `admin.db`. Notes and templates never reach a game service.

Without JavaScript every action still works from its own page
(`/players/<swid>/ban` and so on). `static/app.js` adds dialogs, local
times, reason chips, the ban preview and the live Home view; it writes
text only (never HTML).

## Chat logs (sub-project 2b)

Room chat is logged by the web API when a message is verified
(`POST /chat/v1/message/verify`): who, room and world (from the player's
session), what they typed, what the filter made of it, and a status
(`sent`, `masked`, `blocked`, `muted`). The log says what was submitted, not
whether the game server relayed it: a muted player or a chat command can be
logged and never reach the room. Mix DM threads are not logged.

- **Reading**: the Chat tab on a player's page (their messages) and Chat
  search under More (room, time window of at most 24 hours, text). Needs
  `chat.view` (moderator and up). Every page view writes one audit row
  (`chat.view`: target, query, row count) before any text is shown; if the
  audit row can't be written the view is refused.
- **Retention**: 30 days by default, set by the owner on the Chat search
  page (`chat.retention`, 1-365 days, a reason is required and audited). The
  web API deletes older rows at startup and every 6 hours.
- Chat text is player-controlled, so the pages only render it through the
  escaping template.
- **Cap**: an account can verify at most 60 chat messages a minute. Past that
  the web API answers 429 and signs nothing, so every message that can be
  relayed has a log row (a signed but unlogged message would evade
  moderation).
