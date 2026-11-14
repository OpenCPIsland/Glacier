# Deploying the admin panel

This sits on top of an existing iceberg deployment (services
`iceberg-web-api` and `iceberg-game` running as user `iceberg`, env files
in `/etc/iceberg/`, Bun in `/opt/bun`) and changes nothing in it except
two env files. `admin.example.com` below stands for your panel hostname.
Do the steps in order; nothing is reachable until step 6.

## 1. Copy the code

On your PC: `bash admin-panel/deploy-admin.sh --dry-run`, check the list,
then `bash admin-panel/deploy-admin.sh`. The box gets `/opt/iceberg-admin/`
(root:root, read-only to the services), outside `/opt/iceberg`, so the
services' own user can't change the panel's code and iceberg updates never
touch it.

## 2. Secrets (on the box)

```sh
openssl rand -hex 32   # ADMIN_PANEL_SECRET, shared by all three services
openssl rand -hex 32   # PANEL_CSRF_KEY, panel only
```

Add to `/etc/iceberg/web-api.env` and `/etc/iceberg/game-server.env`
(`sudoedit`, keep their current mode):

```
ADMIN_PANEL_SECRET=<the shared secret>
BUN_OPTIONS=--preload=/opt/iceberg-admin/web-api/src/admin/index.ts           # web-api.env
BUN_OPTIONS=--preload=/opt/iceberg-admin/smartfox-server/src/admin/index.ts   # game-server.env
```

Ports default to 8091 (web API admin) and 8092 (game server admin), both
127.0.0.1 only; ufw stays as it is.

## 3. Panel user, env, unit

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin iceberg-admin
sudo install -m 0600 -o root -g root /dev/null /etc/iceberg/admin-panel.env
sudoedit /etc/iceberg/admin-panel.env
```

```
PANEL_HOST=admin.example.com
CF_ACCESS_TEAM=<team name: the part before .cloudflareaccess.com>
CF_ACCESS_AUD=<Application Audience (AUD) tag from step 5>
ADMIN_PANEL_SECRET=<the shared secret>
PANEL_CSRF_KEY=<the panel key>
PANEL_OWNERS=<your Cloudflare Access login email>
PANEL_DB=/var/lib/iceberg-admin/admin.db
```

systemd reads the env file as root, so mode 600 root:root is right.
`/etc/systemd/system/iceberg-admin.service`: copy `iceberg-web-api.service`
and change only these lines:

```
Description=iceberg admin panel
User=iceberg-admin
Group=iceberg-admin
WorkingDirectory=/opt/iceberg-admin/admin-panel
EnvironmentFile=/etc/iceberg/admin-panel.env
ExecStart=/opt/bun/bin/bun run src/server.ts
StateDirectory=iceberg-admin
MemoryMax=300M
```

Don't start it yet (no Access settings).

## 4. Tunnel

Zero Trust dashboard → Networks → Tunnels → Create (cloudflared) → name
`iceberg-admin` → install on the box with the shown
`sudo cloudflared service install <token>` (after adding Cloudflare's apt
repo as the page says). Public hostname: `admin.example.com` → service
`http://127.0.0.1:8090`. The tunnel only dials out: no ports to open, nginx
and the game hostname are untouched.

## 5. Access

Zero Trust → Access → Applications → Add → Self-hosted:
`admin.example.com`, session 12–24 h. Policy: Allow, Include **Emails**:
each staff email. Login method: an identity provider **with 2FA turned on**
(e.g. Google or GitHub with 2FA required). The panel can't check this
itself: do not use One-time PIN alone. Copy the application's **AUD tag**
into `CF_ACCESS_AUD`. Optional second check: in the tunnel's hostname
settings, turn on "Protect with Access" so cloudflared also verifies tokens.

Adding a staff member later = add their email to this policy **and** to
the panel's Staff page. Either one alone isn't enough.

## 6. Start

```sh
sudo systemctl start iceberg-backup.service          # backup before the web API restarts
sudo systemctl restart iceberg-web-api               # loads the module, installs the role lock
sudo systemctl daemon-reload && sudo systemctl enable --now iceberg-admin
journalctl -u iceberg-web-api -u iceberg-admin -n 30 | grep -E "ADMIN|PANEL"
```

Expect `[ADMIN] web-api module loaded`, `[ADMIN] web-api admin listener on
127.0.0.1:8091`, `[PANEL] admin panel on http://127.0.0.1:8090`. The game
server loads its module on its next restart (`:admin-swre-restart 120`):
`[ADMIN] game-server module loaded`. Then open https://admin.example.com.

## CDN release uploads

The CDN page's "Upload and import" takes a zip of the client generator's
`Export/www` folder. The panel (user `iceberg-admin`) can't write the web
API's data, so it leaves the zip in a shared staging folder and asks the
web API (user `iceberg`) to import it; the web API extracts it strictly
(no paths outside the release, no links, size and count limits) and deletes
the staged file. Both users must create and delete files in that folder,
which needs write permission on the folder itself. It can't live under
`/var/lib/iceberg-admin` (mode 0700, the web API couldn't reach it) or
`/var/lib/iceberg` (the game's data), so it gets its own folder and its own
group:

```sh
# Don't reuse the `iceberg` group for the panel user: it can traverse
# /var/lib/iceberg (the game database and backups), which the panel is
# deliberately kept away from.
sudo groupadd --system iceberg-uploads
sudo usermod -aG iceberg-uploads iceberg
sudo usermod -aG iceberg-uploads iceberg-admin
sudo install -d -m 2770 -o iceberg-admin -g iceberg-uploads /var/lib/iceberg-uploads
```

Both services run with `ProtectSystem=strict`, so each needs the folder
whitelisted (the `-` keeps a unit starting if the folder is ever missing),
and the web API needs somewhere writable for imported releases, since
`/opt/iceberg` is a read-only checkout:

```sh
sudo systemctl edit iceberg-web-api      # add:  [Service]  ReadWritePaths=-/var/lib/iceberg-uploads
sudo systemctl edit iceberg-admin        # add:  [Service]  ReadWritePaths=-/var/lib/iceberg-uploads
echo 'CDN_RELEASES_DIR=/var/lib/iceberg/cdn-releases' | sudo tee -a /etc/iceberg/web-api.env
sudo systemctl daemon-reload
```

`/var/lib/iceberg-uploads` is the default for both services
(`CDN_UPLOAD_DIR` for the panel, `CDN_STAGING_DIR` for the web API override
it; `CDN_UPLOAD_MAX_BYTES` defaults to 100 MB, which is also roughly
Cloudflare's request limit). Restart `iceberg-web-api` and `iceberg-admin`
afterwards so both pick up the group and the drop-ins. Check with an upload
of a tiny test zip before relying on it. Releases larger than the cap: copy
the export folder to the box and run
`CDN_RELEASES_DIR=/var/lib/iceberg/cdn-releases bun tools/cdn-import-release.ts <release folder> <release-id>`
as `iceberg`.

## Backups

The panel's database belongs to `iceberg-admin`, so the game's backup job
(which runs as `iceberg`) can't read it, and shouldn't. It gets its own job,
running as `iceberg-admin` and writing to `/var/lib/iceberg-admin/backups`.

`/usr/local/sbin/iceberg-admin-backup` (mode 0755):

```sh
#!/bin/sh
set -eu
DB=/var/lib/iceberg-admin/admin.db
DIR=/var/lib/iceberg-admin/backups
OUT="$DIR/admin-$(date -u +%Y-%m-%dT%H%M).db"
[ -f "$DB" ] || { echo "no $DB yet" >&2; exit 0; }
install -d -m 0700 "$DIR"
sqlite3 "$DB" ".backup '$OUT'"
[ "$(sqlite3 "$OUT" 'PRAGMA integrity_check;')" = ok ] || { echo "integrity check failed: $OUT" >&2; exit 1; }
gzip "$OUT"
chmod 0600 "$OUT.gz"
find "$DIR" -name 'admin-*.db.gz' -mtime +30 -delete
```

`/etc/systemd/system/iceberg-admin-backup.service`:

```ini
[Unit]
Description=iceberg admin panel database backup
[Service]
Type=oneshot
User=iceberg-admin
Group=iceberg-admin
StateDirectory=iceberg-admin
ExecStart=/usr/local/sbin/iceberg-admin-backup
```

`/etc/systemd/system/iceberg-admin-backup.timer`:

```ini
[Unit]
Description=Nightly iceberg admin panel database backup
[Timer]
OnCalendar=*-*-* 04:20:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

Then `sudo systemctl daemon-reload && sudo systemctl enable --now
iceberg-admin-backup.timer`, and check it once with `sudo systemctl start
iceberg-admin-backup.service && sudo ls -l /var/lib/iceberg-admin/backups/`.
The audit log lives in this database: keep the backups.

## Checking the audit log

The Audit log page's **Verify chain** shows the newest entry's id and hash.
Compare it with the journal, which the panel's user can't edit:

```sh
journalctl -u iceberg-admin | grep '\[AUDIT\]' | tail -1
```

Same id and hash: the log is whole. A later id or a different hash in the
journal means the database was rewritten or rows were cut off the end.
(After restoring a backup the journal is ahead on purpose.)

## PANEL_OWNERS

Owners listed in `PANEL_OWNERS` can't be disabled from the Staff page.
Taking an email out of `PANEL_OWNERS` (then restarting `iceberg-admin`)
disables its row, even if the row was saved to link a game account; the
panel then sets that game account back to player at startup (and every
10 minutes for any disabled row whose account isn't player yet, e.g. when
a server was down; journal: `[PANEL] reconcile`). Another
owner can enable it again on purpose, which makes it an ordinary owner row.

## Rollback

1. `sudo systemctl disable --now iceberg-admin`
2. **If any staff member was ever linked to a game account, remove the role
   lock.** Otherwise `:promote` / `:demote` on those accounts keeps failing
   with "Couldn't change the role", and nothing is left to change them.
   Stop the web API first, or it reinstalls the lock while the preload is
   still set: `sudo systemctl stop iceberg-web-api`, then
   `sudo -u iceberg /opt/bun/bin/bun /opt/iceberg-admin/admin-panel/tools/remove-role-lock.ts --db /var/lib/iceberg/cpi_data.db`
3. Remove the `BUN_OPTIONS` and `ADMIN_PANEL_SECRET` lines from both env
   files, then start / restart the web API and the game server. After steps
   2 and 3 they are plain iceberg again.
4. Only after step 3 may `/opt/iceberg-admin` be deleted: a `BUN_OPTIONS`
   line that points at a missing file stops the service from starting.

## Updating

Run `bash admin-panel/deploy-admin.sh` again, then restart what it lists.
The copy isn't atomic, so don't restart a service while it runs. If one
restarts mid-copy anyway, its admin module logs `[ADMIN] ... failed to
start` and the service runs as plain iceberg; restart it again once the
copy is done.

## Deploying the moderation features (2a)

Order matters because the pieces depend on each other:

1. **Iceberg core** (web API: moderation tables and columns, internal
   endpoints): normal iceberg deploy plus a web API restart. Players stay
   connected; the old game server keeps working.
2. **Admin modules and panel**: `bash admin-panel/deploy-admin.sh --dry-run`,
   then for real; restart `iceberg-admin` and the web API (for its admin
   module). Until step 3 the panel shows the game parts as unavailable and
   mutes reach players at their next login.
3. **Game server** (mute cache and recheck, `:mute` persistence,
   `connectedAt`, the game listener's new routes): **one restart, which
   drops everyone online.** Agree the timing first.
4. **Live check**: player lookup, online list, kick a test account, mute
   and chat, timed ban and login screen, a warning, report resolve, filter
   add and remove, the phone layout.

## Deploying the chat logs (2b)

No game-server change, so **no game restart and nobody is dropped**.

1. **Web API**: normal iceberg deploy, then restart the web API. It adds the
   `chat_log` table (additive; nothing to migrate) and starts logging room
   chat at once. The first purge runs at startup and then every 6 hours,
   using the retention setting (30 days until the owner changes it).
2. **Admin modules and panel**: `bash admin-panel/deploy-admin.sh --dry-run`,
   then for real; restart `iceberg-admin` and the web API again for its
   admin module (the chat read routes). Until the panel is updated the
   disabled "Chat (2b)" tab stays, and logging still works.
3. **Live check**: chat in a room as a test account, open the player's Chat
   tab and Chat search under More, confirm each view shows up in the Audit
   log, and (owner) change the retention and see it audited.

Backups: `cpi_data.db` backups include chat text, so shortening the
retention does not remove chat from backups already taken. Prune old
backups if that matters.

Rollback: restart the previous web API and panel; the `chat_log` table can
stay (nothing reads it). To drop the stored chat now, run
`DELETE FROM chat_log;` against the game database with the web API stopped.
