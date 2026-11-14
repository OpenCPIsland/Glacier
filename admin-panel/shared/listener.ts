// The admin listener both servers run: loopback only, every call signed by
// the panel and checked against the route's own action (a call signed for
// one action can't use another route), proxied requests refused, 64 KB
// body cap, JSON in and out.
import http from "node:http";
import { verifySigned, NonceCache, type Actor } from "./signing.ts";

const MAX_BODY = 64 * 1024;

export type Reply = { status: number; json: unknown };
export interface Route {
  method: "GET" | "POST";
  action: string;
  run(body: any, actor: Actor): Reply;
}

export const badRequest = (msg: string): Reply => ({ status: 400, json: { error: msg } });

export function startSignedListener(label: string, secret: string, port: number, routes: Record<string, Route>): http.Server {
  const nonces = new NonceCache();
  const send = (res: http.ServerResponse, r: Reply) =>
    res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(r.json));

  const server = http.createServer((req, res) => {
    if (req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined || req.headers["x-real-ip"] !== undefined) {
      return send(res, { status: 403, json: { error: "proxied" } });
    }
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on("data", (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; send(res, { status: 413, json: { error: "too large" } }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "/";
      const v = verifySigned(secret, { method: req.method ?? "GET", path, body: raw, headers: req.headers, remoteAddress: req.socket.remoteAddress }, nonces);
      if (!v.ok) {
        console.log(`[ADMIN] ${label}: refused ${req.method} ${path}: ${v.why}`);
        return send(res, { status: v.status, json: { error: v.why } });
      }
      const pathname = new URL(path, "http://x").pathname;
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
      if (!route || route.method !== req.method) return send(res, { status: 404, json: { error: "not found" } });
      if (route.action !== v.action) return send(res, { status: 403, json: { error: "signed for another action" } });
      let body: unknown = undefined;
      if (route.method === "POST") {
        try { body = JSON.parse(raw); } catch { return send(res, badRequest("bad json")); }
      }
      try {
        const r = route.run(body, v.actor);
        console.log(`[ADMIN] ${label}: ${v.actor.email} ${v.action} ${pathname} → ${r.status}`);
        send(res, r);
      } catch (err) {
        console.error(`[ADMIN] ${label}: ${pathname} failed: ${(err as Error).stack}`);
        send(res, { status: 500, json: { error: "internal" } });
      }
    });
  });
  server.on("error", (err) => console.error(`[ADMIN] ${label}: listener error on 127.0.0.1:${port}: ${err.message}`));
  server.listen(port, "127.0.0.1", () => console.log(`[ADMIN] ${label} admin listener on 127.0.0.1:${port}`));
  return server;
}
