// Small pieces the player pages and the action flows share.
import { htmlResponse, withHeaders, type RouteCtx } from "../pipeline.ts";
import { html } from "../web.ts";
import { page } from "./layout.ts";

export const SWID = /^\{[0-9A-Za-z-]{1,64}\}$/;
export const playerPath = (swid: string) => `/players/${encodeURIComponent(swid)}`;
export const DOWN = html`<p class="error">The web API isn't answering. Try again in a moment.</p>`;
export const redirect = (to: string) => withHeaders(new Response(null, { status: 303, headers: { Location: to } }));

export const noPlayer = (ctx: RouteCtx) => htmlResponse(page({ title: "Player", staff: ctx.staff, csrf: ctx.csrf, active: "players", body: html`<p>No such player.</p>` }), 404);
