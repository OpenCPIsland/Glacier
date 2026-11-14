import { html, type SafeHtml } from "../web.ts";
import { can } from "../../shared/permissions.ts";
import type { StaffRow } from "../store.ts";

// The nav badge shows the last open-reports count any page or the live
// poller learned; it is never a reason to call a listener from page().
let knownOpenReports: number | null = null;
export const setOpenReports = (n: number | null) => { knownOpenReports = typeof n === "number" ? n : null; };

export type NavKey = "home" | "players" | "reports" | "more";

// The four phone tabs (also the top of the desktop sidebar).
const TABS: { key: NavKey; href: string; label: string; action: string; icon: string }[] = [
  { key: "home", href: "/", label: "Home", action: "dashboard.view", icon: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" },
  { key: "players", href: "/players", label: "Players", action: "players.view", icon: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0z" },
  { key: "reports", href: "/reports", label: "Reports", action: "reports.view", icon: "M5 3v18M5 4h13l-2 4 2 4H5" },
  { key: "more", href: "/more", label: "More", action: "dashboard.view", icon: "M5 12h.01M12 12h.01M19 12h.01" },
];
// Further pages: listed in the sidebar and on the More page.
export const MORE_LINKS: { href: string; label: string; action: string }[] = [
  { href: "/chat", label: "Chat search", action: "chat.view" },
  { href: "/filter", label: "Word filter", action: "filter.view" },
  { href: "/templates", label: "Reason templates", action: "templates.edit" },
  { href: "/staff", label: "Staff", action: "staff.view" },
  { href: "/cdn", label: "CDN", action: "cdn.view" },
  { href: "/audit", label: "Audit log", action: "audit.view" },
  { href: "/me", label: "Me", action: "dashboard.view" },
];

const icon = (d: string) => html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

export function page(opts: { title: string; staff: StaffRow; csrf: string; body: SafeHtml; active?: NavKey; openReports?: number | null; flash?: string | null }): SafeHtml {
  const { title, staff, csrf, body, active = "more", flash = null } = opts;
  const openReports = opts.openReports ?? knownOpenReports;
  const ok = (action: string) => can(staff.role, staff.extras, action);
  const tabs = TABS.filter((t) => ok(t.action));
  const badge = (t: { key: NavKey }) => (t.key === "reports" && openReports ? html`<span class="badge" data-live="openReports">${openReports}</span>` : "");
  const side = tabs.map((t) => html`<a href="${t.href}"${t.key === active ? html` class="on" aria-current="page"` : ""}>${icon(t.icon)}<span>${t.label}</span>${badge(t)}</a>`);
  const sideMore = MORE_LINKS.filter((l) => ok(l.action)).map((l) => html`<a href="${l.href}">${l.label}</a>`);
  const bar = tabs.map((t) => html`<a href="${t.href}"${t.key === active ? html` class="on" aria-current="page"` : ""}>${icon(t.icon)}<span>${t.label}</span>${badge(t)}</a>`);
  return html`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Iceberg admin</title><link rel="stylesheet" href="/static/panel.css"></head>
<body>
<div class="shell">
<nav class="side" aria-label="Main"><div class="brand">Iceberg <small>admin</small></div>${side}<div class="rule"></div>${sideMore}<div class="who">${staff.email}<br>${staff.role}</div></nav>
<main><h1>${title}</h1>${flash ? html`<div class="flash" role="status">${flash}</div>` : ""}${body}</main>
</div>
<nav class="tabbar" aria-label="Main">${bar}</nav>
<form id="csrf" hidden><input type="hidden" name="_csrf" value="${csrf}"></form>
<script src="/static/app.js" defer></script></body></html>`;
}

export function errorPage(status: number, message: string): SafeHtml {
  return html`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${status}</title><link rel="stylesheet" href="/static/panel.css"></head>
<body><div class="shell"><main><h1>${status}</h1><p>${message}</p></main></div></body></html>`;
}
