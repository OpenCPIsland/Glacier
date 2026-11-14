import { html, type SafeHtml } from "../web.ts";
import { can } from "../../shared/permissions.ts";
import type { StaffRow } from "../store.ts";
import { MORE_LINKS } from "./layout.ts";

export function moreBody(staff: StaffRow): SafeHtml {
  const links = MORE_LINKS.filter((l) => can(staff.role, staff.extras, l.action));
  return html`<ul class="menu">${links.map((l) => html`<li><a href="${l.href}">${l.label}</a></li>`)}</ul>`;
}
