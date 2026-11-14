// Every panel request goes through handle():
//   security headers on every response
//   → Cloudflare Access JWT → per-email rate limit → staff list
//   → (POST) CSRF → permission → reason (when the action needs one) → route.
// The rate limit runs before the staff lookup so a non-staff identity
// can't flood the audit log. Denials are audited.
import { can, actionDef } from "../shared/permissions.ts";
import type { Actor } from "../shared/signing.ts";
import type { AccessVerifier } from "./access-jwt.ts";
import { appendAudit } from "./audit.ts";
import type { PanelConfig } from "./config.ts";
import type { Store, StaffRow } from "./store.ts";
import { SafeHtml, securityHeaders, csrfToken, checkCsrf, RateLimiter } from "./web.ts";
import { errorPage } from "./pages/layout.ts";

export interface RouteCtx {
  req: Request;
  url: URL;
  actor: Actor;
  staff: StaffRow;
  csrf: string;
  form?: FormData;
}

export interface RouteDef {
  action: string;
  method: "GET" | "POST";
  run(ctx: RouteCtx): Promise<Response | SafeHtml>;
}

export interface Pipeline {
  handle(req: Request, route: RouteDef): Promise<Response>;
}

const REASON_MAX = 500;

export function withHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
  if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
  return res;
}

export const htmlResponse = (body: SafeHtml, status = 200) =>
  withHeaders(new Response(body.toString(), { status, headers: { "Content-Type": "text/html; charset=utf-8" } }));

export function makePipeline(cfg: PanelConfig, verifier: AccessVerifier, store: Store): Pipeline {
  const all = new RateLimiter(120);
  const changes = new RateLimiter(20);
  const lastLimitAudit = new Map<string, number>();
  const deny = (status: number, message: string) => htmlResponse(errorPage(status, message), status);
  // A failing audit write (disk full, busy) must not turn a denial into a
  // 500: the denial still stands, and the failure goes to the log.
  const audit = (actor: string, role: string, action: string, url: URL, result: "denied" | "error", detail: string) => {
    try {
      appendAudit(store, { actor, role, action, target: url.pathname.slice(0, 200), params: null, reason: null, result, detail });
    } catch (err) {
      console.error(`[PANEL] audit write failed (${result} ${action} by ${actor}): ${(err as Error).message}`);
    }
  };

  return {
    async handle(req, route) {
      const url = new URL(req.url);
      const jwt = await verifier.verify(req.headers.get("cf-access-jwt-assertion") ?? undefined);
      if (!jwt.ok) {
        console.log(`[PANEL] ${req.method} ${url.pathname}: refused, Access token ${jwt.why}`);
        return deny(403, "Not authorised.");
      }
      const email = jwt.email;

      if (!all.hit(email) || (req.method === "POST" && !changes.hit(email))) {
        const now = Date.now();
        if (now - (lastLimitAudit.get(email) ?? 0) > 60_000) {
          lastLimitAudit.set(email, now);
          audit(email, store.getStaff(email)?.role ?? "none", route.action, url, "denied", "rate limit");
        }
        return deny(429, "Too many requests. Wait a minute.");
      }

      const staff = store.getStaff(email);
      if (!staff || staff.disabled) {
        audit(email, staff?.role ?? "none", "panel.access", url, "denied", staff ? "disabled" : "not on the staff list");
        return deny(403, "Not authorised.");
      }
      const actor: Actor = { email: staff.email, role: staff.role, extras: staff.extras };
      const csrf = csrfToken(cfg.csrfKey, staff.email);

      let form: FormData | undefined;
      if (req.method === "POST") {
        try { form = await req.formData(); } catch { return deny(400, "Bad form."); }
        const token = form.get("_csrf");
        if (!checkCsrf(cfg.csrfKey, staff.email, typeof token === "string" ? token : null, req.headers.get("origin"), cfg.host)) {
          audit(staff.email, staff.role, route.action, url, "denied", "csrf");
          return deny(403, "This form expired or came from another site. Reload the page and try again.");
        }
      }

      if (!can(staff.role, staff.extras, route.action)) {
        audit(staff.email, staff.role, route.action, url, "denied", "not permitted");
        return deny(403, "Your role can't do that.");
      }

      if (form && actionDef(route.action)?.needsReason) {
        const reason = String(form.get("reason") ?? "").trim();
        if (reason.length < 1 || reason.length > REASON_MAX) return deny(400, `A reason (1-${REASON_MAX} characters) is required.`);
      }

      try {
        const out = await route.run({ req, url, actor, staff, csrf, form });
        return out instanceof SafeHtml ? htmlResponse(out) : withHeaders(out);
      } catch (err) {
        console.error(`[PANEL] ${req.method} ${url.pathname} failed: ${(err as Error).stack}`);
        audit(staff.email, staff.role, route.action, url, "error", (err as Error).message.slice(0, 500));
        return deny(500, "Something went wrong. It has been logged.");
      }
    },
  };
}
