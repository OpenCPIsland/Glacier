// CDN page: the switch and the list of client builds the island client's
// boot files are served for, plus the content releases (bundles players
// download instead of embedded content) a build can point at. Admins view
// it; owners change it. A change goes dry run → confirm page → save →
// audit, and a confirm made from a stale page (the list changed meanwhile)
// is refused. A release is uploaded as a zip of the client generator's
// Export/www folder: the panel stages it in a folder the web API can read,
// and the web API extracts it (strictly) and imports it.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { can } from "../../shared/permissions.ts";
import { appendAudit } from "../audit.ts";
import type { Clients } from "../clients.ts";
import type { RouteCtx, RouteDef } from "../pipeline.ts";
import { htmlResponse } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { html, type SafeHtml } from "../web.ts";
import { page, errorPage } from "./layout.ts";

const PLATFORMS = ["standalonewindows64", "standaloneosx", "standalonelinux64", "android", "ios", "webgl"];
const WARNING = "Builds not on this list get the forced-upgrade screen. Turning the CDN off fixes it on their next boot.";
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

interface Entry { client: string; platform: string; contentVersion: string; release?: string }
interface Config { enabled: boolean; entries: Entry[]; setBy?: string; setAt?: string }
interface Release { id: string; bundles: number; platforms: string[]; catalog?: string; importedAt: string }
export interface UploadSettings { dir: string; maxBytes: number }

const key = (e: Entry) => `${e.client}|${e.platform}|${e.contentVersion}|${e.release ?? ""}`;
const label = (e: Entry) => `${e.client} ${e.platform} ${e.contentVersion.slice(0, 8)}${e.release ? ` ${e.release}` : ""}`;
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export function cdnRoutes(clients: Clients, store: Store, uploads: UploadSettings): Record<string, RouteDef> {
  const load = async (ctx: RouteCtx): Promise<{ ok: true; config: Config; releases: Release[] } | { ok: false; res: Response }> => {
    const r = await clients.callWebApi(ctx.actor, "cdn.view", "GET", "/cdn");
    if (r.ok && r.status === 200 && r.json?.config) {
      // An older web API has no releases route yet: the page still works without the list.
      const rel = await clients.callWebApi(ctx.actor, "cdn.view", "GET", "/cdn/releases");
      const releases: Release[] = rel.ok && rel.status === 200 && Array.isArray(rel.json?.releases) ? rel.json.releases : [];
      return { ok: true, config: r.json.config, releases };
    }
    const why = r.ok ? `HTTP ${r.status}` : r.detail;
    return { ok: false, res: htmlResponse(page({ title: "CDN", staff: ctx.staff, csrf: ctx.csrf, body: html`<p class="error">Couldn't load the CDN settings: ${why}</p>` }), 502) };
  };

  function releasesSection(ctx: RouteCtx, releases: Release[], edit: boolean): SafeHtml {
    const table = releases.length
      ? html`<table><thead><tr><th>Release</th><th>Bundles</th><th>Platforms</th><th>Catalog</th><th>Imported</th></tr></thead><tbody>${releases.map((r) => html`<tr><td>${r.id}</td><td>${r.bundles}</td><td>${r.platforms.join(", ")}</td><td>${r.catalog ?? ""}</td><td>${r.importedAt}</td></tr>`)}</tbody></table>`
      : html`<p class="muted">No releases imported yet.</p>`;
    const form = edit ? html`<form method="post" action="/cdn/releases/upload" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="${ctx.csrf}">
<p><label>Release id <input name="id" placeholder="2026-11-sprite-test" size="30"></label> <label>Zip of the update build's platform folders (or the generator's Export/www folder) <input type="file" name="file" accept=".zip"></label> <button>Upload and import</button></p>
<p class="muted">Up to ${mb(uploads.maxBytes)}. The zip holds one folder per platform (StandaloneLinux64, Android, ...), each with its catalog, .hash and .bundle files. A release can't be replaced: use a new id for a new version. Larger releases: tools/cdn-import-release.ts on the server.</p></form>` : html``;
    return html`<h2>Releases</h2><p class="muted">Content players download instead of embedded content. A build uses one only if its row names it.</p>${table}${form}`;
  }

  function listing(ctx: RouteCtx, c: Config, releases: Release[], banner?: SafeHtml): SafeHtml {
    const edit = can(ctx.staff.role, ctx.staff.extras, "cdn.edit");
    const status = html`<p>The CDN is <b>${c.enabled ? "on" : "off"}</b> (${c.setAt ? html`set by ${c.setBy ?? "?"} at ${c.setAt}` : html`never set`}).</p><p class="warn">${WARNING}</p>`;
    if (!edit) {
      return page({
        title: "CDN", staff: ctx.staff, csrf: ctx.csrf,
        body: html`${banner ?? html``}${status}<table><thead><tr><th>Client</th><th>Platform</th><th>Content version</th><th>Release</th></tr></thead><tbody>${c.entries.map((e) => html`<tr><td>${e.client}</td><td>${e.platform}</td><td><code>${e.contentVersion}</code></td><td>${e.release ?? ""}</td></tr>`)}</tbody></table>${releasesSection(ctx, releases, false)}`,
      });
    }
    const select = (cur: string) => html`<select name="platform">${PLATFORMS.map((p) => html`<option value="${p}"${p === cur ? html` selected` : html``}>${p}</option>`)}</select>`;
    // A row naming a release that isn't listed (deleted from disk) keeps its choice, so a save doesn't silently drop it.
    // A row is offered only releases that cover its platform; a new row (no platform yet) is offered all of them.
    const releaseSelect = (cur: string, platform = "") => {
      const ids = releases.filter((r) => !platform || r.platforms.includes(platform)).map((r) => r.id);
      if (cur && !ids.includes(cur)) ids.push(cur);
      return html`<select name="release"><option value=""${cur === "" ? html` selected` : html``}>embedded</option>${ids.map((id) => html`<option value="${id}"${id === cur ? html` selected` : html``}>${id}</option>`)}</select>`;
    };
    const rows = [...c.entries.map((e, i) => html`<tr><td><input name="client" value="${e.client}"></td><td>${select(e.platform)}</td><td><input name="contentVersion" value="${e.contentVersion}" size="42"></td><td>${releaseSelect(e.release ?? "", e.platform)}</td><td><label><input type="checkbox" name="remove" value="${i}"> remove</label></td></tr>`),
      html`<tr><td><input name="client" placeholder="1.15.0"></td><td>${select("")}</td><td><input name="contentVersion" size="42" placeholder="40 hex characters"></td><td>${releaseSelect("")}</td><td class="muted">new row</td></tr>`];
    return page({
      title: "CDN", staff: ctx.staff, csrf: ctx.csrf,
      body: html`${banner ?? html``}${status}<form method="post" action="/cdn/save"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="rev" value="${c.setAt ?? "none"}">
<p><label><input type="checkbox" name="enabled" value="1"${c.enabled ? html` checked` : html``}> CDN on</label></p>
<table><thead><tr><th>Client</th><th>Platform</th><th>Content version</th><th>Content</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p><label>Import rows (JSON printed by tools/cdn-seed-versions.ts)<br><textarea name="import" rows="4" cols="80"></textarea></label></p>
<button>Review…</button></form>${releasesSection(ctx, releases, true)}`,
    });
  }

  const staleCopy = "The CDN settings changed since you opened this page (another owner may have edited them). Go back to CDN and try again.";

  return {
    "GET /cdn": {
      action: "cdn.view", method: "GET",
      async run(ctx) { const l = await load(ctx); return l.ok ? listing(ctx, l.config, l.releases) : l.res; },
    },
    "POST /cdn/releases/upload": {
      action: "cdn.edit", method: "POST",
      async run(ctx) {
        const f = ctx.form!;
        const id = String(f.get("id") ?? "").trim();
        const file = f.get("file");
        const fail = (status: number, msg: string, detail: string | null = msg) => {
          appendAudit(store, { actor: ctx.staff.email, role: ctx.staff.role, action: "cdn.edit", target: `cdn_release:${id.slice(0, 40)}`, params: { upload: true }, reason: null, result: "error", detail: detail?.slice(0, 300) ?? null });
          return htmlResponse(errorPage(status, msg), status);
        };
        if (!RELEASE_ID.test(id)) return htmlResponse(errorPage(400, "Bad release id: use letters, digits, . _ - (up to 40, starting with a letter or digit)."), 400);
        if (!file || typeof file === "string" || file.size === 0) return htmlResponse(errorPage(400, "Choose a zip file to upload."), 400);
        if (file.size > uploads.maxBytes) return htmlResponse(errorPage(413, `That file is too large (limit ${mb(uploads.maxBytes)}). Use tools/cdn-import-release.ts on the server for larger releases.`), 413);

        const staged = `${randomBytes(16).toString("hex")}.zip`;
        const path = join(uploads.dir, staged);
        try {
          writeFileSync(path, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o640 });
          const r = await clients.callWebApi(ctx.actor, "cdn.edit", "POST", "/cdn/releases/import", { staged, id });
          if (!r.ok) return fail(502, `Couldn't reach the web API: ${r.detail}`);
          if (r.status === 409) return fail(409, `A release named ${id} already exists. Use a new id.`);
          if (r.status !== 200 || !r.json?.release) return fail(r.status === 400 ? 400 : 502, r.status === 400 ? String(r.json?.error ?? "Refused.") : `The web API answered HTTP ${r.status}.`);
          const rel: Release = r.json.release;
          appendAudit(store, {
            actor: ctx.staff.email, role: ctx.staff.role, action: "cdn.edit", target: `cdn_release:${rel.id}`,
            params: { upload: true, bytes: file.size, bundles: rel.bundles, platforms: rel.platforms }, reason: null, result: "ok", detail: null,
          });
          const l = await load(ctx);
          if (!l.ok) return l.res;
          return listing(ctx, l.config, l.releases, html`<p class="muted">Imported release <b>${rel.id}</b>: ${rel.bundles} bundle(s) for ${rel.platforms.join(", ")}. Give a build this release below to use it.</p>`);
        } catch (err) {
          return fail(500, "Couldn't stage the upload. It has been logged.", (err as Error).message);
        } finally {
          rmSync(path, { force: true });
        }
      },
    },
    "POST /cdn/save": {
      action: "cdn.edit", method: "POST",
      async run(ctx) {
        const f = ctx.form!;
        const l = await load(ctx);
        if (!l.ok) return l.res;
        const current = l.config;

        const [cl, pl, cv, rl] = [f.getAll("client"), f.getAll("platform"), f.getAll("contentVersion"), f.getAll("release")].map((a) => a.map(String));
        const removed = new Set(f.getAll("remove").map(String));
        const proposed: Entry[] = [];
        for (let i = 0; i < cl!.length; i++) {
          if (removed.has(String(i))) continue;
          const e: Entry = { client: cl![i]!.trim(), platform: pl![i] ?? "", contentVersion: (cv![i] ?? "").trim() };
          const release = (rl![i] ?? "").trim();
          if (release) e.release = release;
          if (!e.client && !e.contentVersion) continue; // the blank add row
          proposed.push(e);
        }
        const imp = String(f.get("import") ?? "").trim();
        if (imp) {
          let parsed: unknown;
          try { parsed = JSON.parse(imp); } catch { parsed = null; }
          if (!Array.isArray(parsed) || parsed.some((e) => !e || typeof e !== "object")) return htmlResponse(errorPage(400, "Import isn't a JSON array of rows."), 400);
          for (const e of parsed as any[]) {
            const row: Entry = { client: String(e.client ?? ""), platform: String(e.platform ?? ""), contentVersion: String(e.contentVersion ?? "") };
            if (e.release !== undefined && e.release !== "") row.release = String(e.release);
            if (!proposed.some((p) => key(p) === key(row))) proposed.push(row);
          }
        }
        const enabled = f.get("enabled") === "1";
        const rev = String(f.get("rev") ?? "none");
        const body = { enabled, entries: proposed, expectSetAt: rev === "none" ? null : rev };
        const confirmed = f.get("confirm") === "1";

        const r = await clients.callWebApi(ctx.actor, "cdn.edit", "POST", "/cdn/save", { ...body, dryRun: !confirmed });
        if (!r.ok) return htmlResponse(errorPage(502, `Couldn't reach the web API: ${r.detail}`), 502);
        if (r.status === 409) return htmlResponse(errorPage(409, staleCopy), 409);
        if (r.status === 400) return htmlResponse(errorPage(400, String(r.json?.error ?? "Refused.")), 400);
        if (r.status !== 200 || !r.json?.config) return htmlResponse(errorPage(502, `The web API answered HTTP ${r.status}.`), 502);
        const after: Config = r.json.config;

        const before = new Map(current.entries.map((e) => [key(e), e]));
        const next = new Map(after.entries.map((e) => [key(e), e]));
        const added = after.entries.filter((e) => !before.has(key(e)));
        const gone = current.entries.filter((e) => !next.has(key(e)));

        if (!confirmed) {
          const headline = current.enabled === after.enabled ? (after.enabled ? "Keep the CDN on" : "Keep the CDN off") : after.enabled ? "Turn the CDN on" : "Turn the CDN off";
          return page({
            title: "Confirm", staff: ctx.staff, csrf: ctx.csrf,
            body: html`<p><b>${headline}</b> with ${after.entries.length} build(s).</p>
<p>Added: ${added.length ? added.map((e) => html`<code>${label(e)}</code> `) : html`none`}</p>
<p>Removed: ${gone.length ? gone.map((e) => html`<code>${label(e)}</code> `) : html`none`}</p>
${after.enabled ? html`<p class="warn">${WARNING}</p>` : html``}
<form method="post" action="/cdn/save"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="rev" value="${rev}">
${after.enabled ? html`<input type="hidden" name="enabled" value="1">` : html``}
${after.entries.map((e) => html`<input type="hidden" name="client" value="${e.client}"><input type="hidden" name="platform" value="${e.platform}"><input type="hidden" name="contentVersion" value="${e.contentVersion}"><input type="hidden" name="release" value="${e.release ?? ""}">`)}
<input type="hidden" name="confirm" value="1"><button>Confirm</button> <a href="/cdn">Cancel</a></form>`,
          });
        }

        appendAudit(store, {
          actor: ctx.staff.email, role: ctx.staff.role, action: "cdn.edit", target: "cdn_config",
          params: { before: { enabled: current.enabled, entries: current.entries.length }, after: { enabled: after.enabled, entries: after.entries.length }, added: added.map(label), removed: gone.map(label) },
          reason: null, result: "ok", detail: null,
        });
        const fresh = await load(ctx);
        return listing(ctx, after, fresh.ok ? fresh.releases : l.releases, html`<p class="muted">Saved. Clients pick this up on their next boot.</p>`);
      },
    },
  };
}
