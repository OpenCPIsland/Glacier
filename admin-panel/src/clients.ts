// Signed calls from the panel to the two admin listeners. No retries: a
// failed call is reported as unreachable so an action never runs twice.
import { signHeaders, type Actor } from "../shared/signing.ts";

export type CallResult = { ok: true; status: number; json: any } | { ok: false; unreachable: true; detail: string };
type Call = (actor: Actor, action: string, method: "GET" | "POST", path: string, body?: unknown) => Promise<CallResult>;

export interface Clients {
  callWebApi: Call;
  callGameServer: Call;
}

function client(base: string, secret: string): Call {
  return async (actor, action, method, path, body) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    try {
      const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...signHeaders(secret, method, path, raw, actor, action) },
        body: method === "POST" ? raw : undefined,
        signal: AbortSignal.timeout(5000),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* empty or non-JSON body */ }
      return { ok: true, status: res.status, json };
    } catch (err) {
      return { ok: false, unreachable: true, detail: (err as Error).message };
    }
  };
}

export function makeClients(webapiUrl: string, gameUrl: string, secret: string): Clients {
  return { callWebApi: client(webapiUrl, secret), callGameServer: client(gameUrl, secret) };
}
