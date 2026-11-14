// Audit log page (admins): filters, keyset paging on id, chain check.
import { queryAudit, verifyChain, type AuditFilter } from "../audit.ts";
import type { RouteCtx, RouteDef } from "../pipeline.ts";
import type { Store } from "../store.ts";
import { html, playerText, type SafeHtml } from "../web.ts";
import { page } from "./layout.ts";

const PAGE = 50;
const DAY_MS = 86_400_000;
const RESULTS = ["ok", "denied", "error", "unreachable"];

const day = (v: string | null): number | undefined => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t;
};
const text = (v: string | null, max = 254) => (v && v.length <= max ? v : undefined);

function filterFrom(url: URL): { f: AuditFilter; params: Record<string, string> } {
  const q = url.searchParams;
  const params: Record<string, string> = {};
  for (const k of ["actor", "action", "target", "result", "from", "to"]) {
    const v = q.get(k);
    if (v) params[k] = v;
  }
  const to = day(q.get("to"));
  const before = q.get("before");
  return {
    params,
    f: {
      actor: text(q.get("actor"))?.toLowerCase(),
      action: text(q.get("action"), 64),
      target: text(q.get("target")),
      result: RESULTS.includes(q.get("result") ?? "") ? q.get("result")! : undefined,
      from: day(q.get("from")),
      to: to === undefined ? undefined : to + DAY_MS, // "to" is inclusive
      before: before && /^\d{1,15}$/.test(before) ? Number(before) : undefined,
      limit: PAGE,
    },
  };
}

function render(ctx: RouteCtx, store: Store, notice?: SafeHtml): SafeHtml {
  const { f, params } = filterFrom(ctx.url);
  const rows = queryAudit(store, f);
  const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 19);
  const body = rows.map((r) => html`<tr data-id="${r.id}"><td>${r.id}</td><td>${when(r.at)}</td><td>${playerText(r.actor)}</td><td>${r.role}</td><td>${r.action}</td>
<td>${playerText(r.target)}</td><td>${r.result}</td><td>${playerText(r.reason)}</td><td>${playerText(r.detail)}</td><td><code>${playerText(r.params === null ? "" : JSON.stringify(r.params))}</code></td></tr>`);
  const nextQs = new URLSearchParams({ ...params, before: String(rows.at(-1)?.id ?? "") }).toString();
  const input = (name: string, ph: string, type = "text") => html`<input name="${name}" type="${type}" placeholder="${ph}" value="${params[name] ?? ""}">`;
  return page({
    title: "Audit log", staff: ctx.staff, csrf: ctx.csrf,
    body: html`${notice ?? html``}
<form method="get" action="/audit">${input("actor", "staff email")} ${input("action", "action")} ${input("target", "target")}
<select name="result"><option value="">any result</option>${RESULTS.map((r) => html`<option value="${r}"${params.result === r ? html` selected` : html``}>${r}</option>`)}</select>
from ${input("from", "YYYY-MM-DD", "date")} to ${input("to", "YYYY-MM-DD", "date")} <button>Filter</button> <a href="/audit">Clear</a></form>
<form method="post" action="/audit/verify"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button>Verify chain</button></form>
<table><thead><tr><th>#</th><th>When (UTC)</th><th>Staff</th><th>Role</th><th>Action</th><th>Target</th><th>Result</th><th>Reason</th><th>Detail</th><th>Params</th></tr></thead>
<tbody>${body}</tbody></table>
${rows.length === PAGE ? html`<p><a href="/audit?${nextQs}">Older entries →</a></p>` : html`<p class="muted">End of log.</p>`}`,
  });
}

export function auditRoutes(store: Store): Record<string, RouteDef> {
  return {
    "GET /audit": { action: "audit.view", method: "GET", run: async (ctx) => render(ctx, store) },
    "POST /audit/verify": {
      action: "audit.verify", method: "POST",
      async run(ctx) {
        const v = verifyChain(store);
        const notice = v.ok
          ? html`<p class="muted">Chain intact (${v.count} entries).${v.head ? html` Newest: #${v.head.id} <code>${v.head.hash}</code>. It should match the last <code>[AUDIT]</code> line in <code>journalctl -u iceberg-admin</code>; if the journal has a later or different one, the database was rewritten or cut short.` : html``}</p>`
          : html`<p class="error">Chain broken at entry #${v.brokenAt}: that entry or the one before it was changed or removed.</p>`;
        return render({ ...ctx, url: new URL("/audit", ctx.url) }, store, notice);
      },
    },
  };
}
