import { html, playerText, type SafeHtml } from "../web.ts";
import type { StaffRow } from "../store.ts";
import type { AuditRow } from "../audit.ts";

export function meBody(staff: StaffRow, recent: AuditRow[]): SafeHtml {
  const rows = recent.map((r) => html`<tr><td>${new Date(r.at).toISOString().replace("T", " ").slice(0, 19)}</td><td>${r.action}</td><td>${playerText(r.target)}</td><td>${r.result}</td></tr>`);
  return html`<dl><dt>Email</dt><dd>${staff.email}</dd><dt>Role</dt><dd>${staff.role}</dd>
<dt>Extra permissions</dt><dd>${staff.extras.length ? staff.extras.join(", ") : "none"}</dd>
<dt>Linked game account</dt><dd>${staff.linkedSwid ?? "none"}</dd></dl>
<h2>Your last 50 actions</h2>
<table><thead><tr><th>When (UTC)</th><th>Action</th><th>Target</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
}
