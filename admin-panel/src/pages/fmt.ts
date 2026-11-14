import { html, type SafeHtml } from "../web.ts";

/** A timestamp (ISO text or epoch ms) as <time>; app.js shows it in local time. */
export function when(v: string | number | null | undefined): SafeHtml {
  if (v === null || v === undefined || v === "") return html`<span class="muted">–</span>`;
  const d = typeof v === "number" ? new Date(v) : new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return html`${String(v)}`;
  return html`<time datetime="${d.toISOString()}">${d.toISOString().replace("T", " ").slice(0, 16)} UTC</time>`;
}
