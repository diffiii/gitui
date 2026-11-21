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
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
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
export const loopbackListener = (allowedOrigins: string[]) =>
  Effect.map(loadToken(), (token): LoopbackListener => ({
    kind: "loopback",
    allowedOrigins,
    token,
  }));

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

/** A request's headers, by lowercase name. */
type Headers = Readonly<Record<string, string | undefined>>;

/** What a listener lets through; `authError` is why a request may not proceed, if it may not. */
interface Rules {
  hostAllowed: (host: string) => boolean;
  allowedOrigins: string[];
  authError: (headers: Headers, crossOrigin: boolean) => string | null;
  repoScope: RepoScope;
}

// A browser's Host always carries the port it connected to, so only the hostname is checked.
const hostname = (host: string) => host.replace(/:\d+$/, "");

function loopbackRules(listener: LoopbackListener): Rules {
  const bearer = `Bearer ${listener.token}`;
  return {
    hostAllowed: (host) => isLoopbackHost(hostname(host)),
    allowedOrigins: listener.allowedOrigins,
    authError: (headers, crossOrigin) =>
      !crossOrigin || safeEqual(headers.authorization ?? "", bearer)
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

/** Whether `url` (a request's path and query) is under /api. */
const isApi = (url: string) => {
  const path = url.split("?", 1)[0]!;
  return path === "/api" || path.startsWith("/api/");
};

/**
 * The access checks on `/api/*`, as global router middleware, and the listener's repository
 * scope, for its RepoGate (repo-scope.ts).
 */
export function access({ listener }: AccessOptions) {
  const { hostAllowed, allowedOrigins, authError, repoScope } = rules(listener);

  const middleware = HttpRouter.middleware(
    (route) =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        if (!isApi(req.url)) return yield* route;
        const headers: Headers = req.headers;
        const host = headers.host ?? "";
        if (!hostAllowed(host)) return HttpServerResponse.text("Forbidden host", { status: 403 });

        const origin = headers.origin;
        const crossOrigin = origin !== undefined && origin !== `http://${host}`;
        // Every response to an allowed cross-origin page carries these, errors included.
        let cors: Record<string, string> = {};
        if (crossOrigin) {
          if (!allowedOrigins.includes(origin)) {
            return HttpServerResponse.text("Forbidden origin", { status: 403 });
          }
          cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
          if (req.method === "OPTIONS") {
            return HttpServerResponse.empty({
              status: 204,
              headers: {
                ...cors,
                "Access-Control-Allow-Methods": "GET, POST",
                "Access-Control-Allow-Headers": `${CLIENT_HEADER}, content-type, authorization`,
                // Older Chrome sends a private-network preflight before a public page calls
                // localhost.
                "Access-Control-Allow-Private-Network": "true",
                "Access-Control-Max-Age": "600",
              },
            });
          }
        }
        const withCors = HttpServerResponse.setHeaders(cors);

        if (headers[CLIENT_HEADER] !== "1")
          return HttpServerResponse.text("Forbidden", { status: 403 });
        // A JSON 401 (with CORS headers) lets the page tell "not paired" from "CLI not running".
        const error = authError(headers, crossOrigin);
        if (error) return withCors(HttpServerResponse.jsonUnsafe({ error }, { status: 401 }));
        return withCors(yield* route);
      }),
    { global: true },
  );
  return { middleware, repoScope };
}
