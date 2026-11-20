// Who may call the API, by how the server listens.
//
// Every request must carry the client header, which cross-origin pages can't send without a CORS
// preflight. GETs need it too: they run git in the requested directory. The Host must name this
// server (defends against DNS rebinding).
//
// - loopback (the default): the server listens on 127.0.0.1. Same-origin requests (no Origin, or
//   the server's own) need nothing else. Allowed cross-origin pages, like the hosted web app, get
//   CORS headers and must also send the pairing token. Any other origin is refused.
// - nearby (`--nearby`): requests that a guest sends over a WebRTC data channel, which binds no
//   socket. The channel is the authentication: nearby/peer.ts hands it to the bridge only after
//   the guest proved it knows the code gitui printed (nearby/auth.ts). The bridge gives every
//   request the Host NEARBY_HOST, so this app refuses anything that reaches it any other way, and
//   it has no cross-origin callers.
//
// Repositories: each listener has a RepoScope, which repo-scope.ts enforces. Clients on this
// computer (loopback) may open any repository; clients on other devices (nearby) only those opened
// on this computer.
import { timingSafeEqual } from "node:crypto";
import { CLIENT_HEADER, isLoopbackHost } from "@gitui/shared";
import type { Context, Env, Hono } from "hono";
import { loadToken } from "./config.ts";
import type { RepoScope } from "./repo-scope.ts";

/** Listens on 127.0.0.1; serves same-origin pages and the allowed cross-origin ones. */
export interface LoopbackListener {
  kind: "loopback";
  /** Cross-origin pages allowed to call the API, e.g. HOSTED_ORIGIN. */
  allowedOrigins: string[];
  /** Pairing token cross-origin pages must send as `Authorization: Bearer <token>`. */
  token: string;
}

/** Takes the requests of authenticated nearby data channels, through nearby/bridge.ts. */
export interface NearbyListener {
  kind: "nearby";
}

export type Listener = LoopbackListener | NearbyListener;

export interface AccessOptions {
  listener: Listener;
}

/** A loopback listener with the pairing token from the config dir. */
export const loopbackListener = async (allowedOrigins: string[]): Promise<LoopbackListener> => ({
  kind: "loopback",
  allowedOrigins,
  token: await loadToken(),
});

/** The Host of every request the nearby bridge makes; a reserved name, so no socket gets it. */
export const NEARBY_HOST = "nearby.invalid";

/** `value` if it is exactly an origin (scheme://host[:port]), else null. */
export function parseOrigin(value: string | undefined): string | null {
  return value && URL.parse(value)?.origin === value ? value : null;
}

/** Constant-time string comparison. */
export function safeEqual(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What a listener lets through; `authError` is why a request may not proceed, if it may not. */
interface Rules {
  hostAllowed: (host: string) => boolean;
  allowedOrigins: string[];
  authError: (c: Context, crossOrigin: boolean) => string | null;
  repoScope: RepoScope;
}

// A browser's Host always carries the port it connected to, so only the hostname is checked.
const hostname = (host: string) => host.replace(/:\d+$/, "");

function loopbackRules(listener: LoopbackListener): Rules {
  const bearer = `Bearer ${listener.token}`;
  return {
    hostAllowed: (host) => isLoopbackHost(hostname(host)),
    allowedOrigins: listener.allowedOrigins,
    authError: (c, crossOrigin) =>
      !crossOrigin || safeEqual(c.req.header("authorization") ?? "", bearer)
        ? null
        : "Missing or invalid pairing token",
    // This computer's own browsers, the hosted app paired over 127.0.0.1 included.
    repoScope: "any",
  };
}

/** The channel already authenticated the guest; the Host shows the request came through it. */
const nearbyRules = (): Rules => ({
  hostAllowed: (host) => host === NEARBY_HOST,
  allowedOrigins: [],
  authError: () => null,
  repoScope: "opened",
});

function rules(listener: Listener): Rules {
  switch (listener.kind) {
    case "loopback":
      return loopbackRules(listener);
    case "nearby":
      return nearbyRules();
  }
}

/**
 * Adds the access checks to `/api/*`. Returns the listener's repository scope, for its RepoGate
 * (repo-scope.ts).
 */
export function installAccess<E extends Env>(
  app: Hono<E>,
  { listener }: AccessOptions,
): { repoScope: RepoScope } {
  const { hostAllowed, allowedOrigins, authError, repoScope } = rules(listener);

  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!hostAllowed(host)) return c.text("Forbidden host", 403);

    const origin = c.req.header("origin");
    const crossOrigin = origin !== undefined && origin !== `http://${host}`;
    if (crossOrigin) {
      if (!allowedOrigins.includes(origin)) return c.text("Forbidden origin", 403);
      // Set before the handler runs, so every response carries them, errors from onError too.
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      if (c.req.method === "OPTIONS") {
        c.header("Access-Control-Allow-Methods", "GET, POST");
        c.header("Access-Control-Allow-Headers", `${CLIENT_HEADER}, content-type, authorization`);
        // Older Chrome sends a private-network preflight before a public page calls localhost.
        c.header("Access-Control-Allow-Private-Network", "true");
        c.header("Access-Control-Max-Age", "600");
        return c.body(null, 204);
      }
    }

    if (c.req.header(CLIENT_HEADER) !== "1") return c.text("Forbidden", 403);
    // A JSON 401 (with CORS headers) lets the page tell "not paired" from "CLI not running".
    const error = authError(c, crossOrigin);
    if (error) return c.json({ error }, 401);
    await next();
  });
  return { repoScope };
}
