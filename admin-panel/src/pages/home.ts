import { html, playerText, type SafeHtml } from "../web.ts";
import type { AuditRow } from "../audit.ts";

export interface HomeData { canPlayers: boolean; canReports: boolean; recent: AuditRow[] | null }

const tile = (key: string, label: string) => html`<div class="tile"><div class="num" data-live="${key}">…</div><div class="lbl">${label}</div></div>`;

export function homeBody(d: HomeData): SafeHtml {
  const tiles = [d.canPlayers ? tile("online", "Online now") : "", d.canReports ? tile("openReports", "Open reports") : "", d.canPlayers ? tile("activeMutes", "Active mutes") : "", d.canPlayers ? tile("activeBans", "Active bans") : ""];
  const recent = d.recent && d.recent.length
    ? html`<h2>Recent staff actions</h2><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th></tr></thead><tbody>${d.recent.map((r) => html`<tr><td><time datetime="${new Date(r.at).toISOString()}">${new Date(r.at).toISOString().replace("T", " ").slice(0, 16)} UTC</time></td><td>${r.actor}</td><td>${r.action}</td><td>${playerText(r.target)}</td><td>${r.result}</td></tr>`)}</tbody></table>`
    : "";
  return html`${d.canPlayers ? html`<form class="search" action="/players" method="get" role="search"><input type="search" name="q" placeholder="Find a player by name or id" maxlength="64" required aria-label="Player search"><button type="submit">Search</button></form>` : ""}
<section id="live" data-src="/live/home"><div class="tiles">${tiles}</div>
<p class="status muted">Web API <b data-live="webapi">…</b> · Game server <b data-live="game">…</b> · updates every 5 seconds</p>
${d.canPlayers ? html`<h2>Rooms</h2><div class="rooms" data-live-rooms><p class="muted">Loading…</p></div>` : ""}</section>
${recent}`;
}
