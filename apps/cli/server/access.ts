// Who may call the API, by how the server listens.
//
// Every request must carry the client header, which cross-origin pages can't send without a CORS
// preflight. GETs need it too: they run git in the requested directory. The Host must name this
// server (defends against DNS rebinding).
//
// - loopback (the default): the server listens on 127.0.0.1. Same-origin requests (no Origin, or
//   the server's own) need nothing else. Allowed cross-origin pages, like the hosted web app, get
//   CORS headers and must also send the pairing token. Any other origin is refused.
// - lan (`--lan`): the server listens on a network address, so anyone on the network can reach
//   it. It serves its own UI only: no cross-origin pages, and every API request needs the session
//   cookie that `/pair?key=<secret>` sets. The secret is made per run and travels over plain
//   HTTP, so it is not the pairing token and can't pair the hosted app. Cookies ignore ports:
//   every other web service on this address gets the session cookie too, so LAN mode trusts
//   whatever else runs on this machine.
// - nearby (`--nearby`): requests that a guest sends over a WebRTC data channel, which binds no
//   socket. The channel is the authentication: nearby/peer.ts hands it to the bridge only after
//   the guest proved it knows the code gitui printed (nearby/auth.ts). The bridge gives every
//   request the Host NEARBY_HOST, so this app refuses anything that reaches it any other way, and
//   it has no cross-origin callers.
//
// Repositories: each listener has a RepoScope, which repo-scope.ts enforces. Clients on this
// computer (loopback) may open any repository; clients on other devices (lan, nearby) only those
// opened on this computer.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CLIENT_HEADER, isLoopbackHost } from "@gitui/shared";
import type { Context, Env, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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

/** Listens on a network address; serves its own pages once `/pair` has set their session. */
export interface LanListener {
  kind: "lan";
  /** The IPv4 address the server listens on. */
  address: string;
  /** Key in the pairing link, which `/pair` trades for the session cookie. */
  secret: string;
  /** Name of the session cookie, made per run: SESSION_COOKIE_PREFIX and a random suffix. */
  cookie: string;
}

/** Takes the requests of authenticated nearby data channels, through nearby/bridge.ts. */
export interface NearbyListener {
  kind: "nearby";
}

/** The listeners that bind a socket. */
export type SocketListener = LoopbackListener | LanListener;

export type Listener = SocketListener | NearbyListener;

export interface AccessOptions {
  listener: Listener;
}

/** A loopback listener with the pairing token from the config dir. */
export const loopbackListener = async (allowedOrigins: string[]): Promise<LoopbackListener> => ({
  kind: "loopback",
  allowedOrigins,
  token: await loadToken(),
});

/**
 * Start of every LAN session cookie's name. The rest is made per run, so another gitui on this
 * address has its own cookie, and a restarted one doesn't take an old cookie for its session.
 */
const SESSION_COOKIE_PREFIX = "gitui-session-";

/** How long a session cookie lasts, in seconds; it stops working anyway once gitui restarts. */
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/** A LAN listener on `address`, with a fresh secret and cookie name. */
export const lanListener = (address: string): LanListener => ({
  kind: "lan",
  address,
  // 128 bits keep the pairing link, and its QR code, short.
  secret: randomBytes(16).toString("base64url"),
  cookie: `${SESSION_COOKIE_PREFIX}${randomBytes(4).toString("hex")}`,
});

/** The Host of every request the nearby bridge makes; a reserved name, so no socket gets it. */
export const NEARBY_HOST = "nearby.invalid";

/** The address to bind for `listener`. */
export const listenAddress = (listener: SocketListener) =>
  listener.kind === "lan" ? listener.address : "127.0.0.1";

/** The link that pairs a browser with a LAN listener: it opens the UI with a session. */
export function lanPairingUrl(listener: LanListener, port: number) {
  return `http://${listener.address}:${port}/pair?key=${encodeURIComponent(listener.secret)}`;
}

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

/**
 * What a listener lets through; `authError` is why a request may not proceed, if it may not.
 * `routes` adds what the listener serves outside `/api`.
 */
interface Rules {
  hostAllowed: (host: string) => boolean;
  allowedOrigins: string[];
  authError: (c: Context, crossOrigin: boolean) => string | null;
  repoScope: RepoScope;
  routes?: <E extends Env>(app: Hono<E>) => void;
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

function lanRules(listener: LanListener): Rules {
  const hostAllowed = (host: string) => hostname(host) === listener.address;
  return {
    hostAllowed,
    allowedOrigins: [],
    authError: (c) =>
      safeEqual(getCookie(c, listener.cookie) ?? "", listener.secret)
        ? null
        : "Not paired: open the link gitui printed",
    repoScope: "opened",
    // The pairing link: trades the key for the session cookie and opens the UI.
    routes: (app) =>
      app.get("/pair", (c) => {
        if (!hostAllowed(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
        if (!safeEqual(c.req.query("key") ?? "", listener.secret)) {
          return c.text("Invalid pairing key: open the link gitui printed", 403);
        }
        // Drop the sessions of earlier runs, which would otherwise pile up for 30 days. This
        // unpairs the browser from any other gitui running on this address at the same time.
        for (const name of Object.keys(getCookie(c))) {
          if (name.startsWith(SESSION_COOKIE_PREFIX) && name !== listener.cookie) {
            deleteCookie(c, name, { path: "/" });
          }
        }
        setCookie(c, listener.cookie, listener.secret, {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          maxAge: SESSION_MAX_AGE,
        });
        return c.redirect("/");
      }),
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
    case "lan":
      return lanRules(listener);
    case "nearby":
      return nearbyRules();
  }
}

/**
 * Adds the access checks to `/api/*`, and the listener's own routes. Returns the listener's
 * repository scope, for its RepoGate (repo-scope.ts).
 */
export function installAccess<E extends Env>(
  app: Hono<E>,
  { listener }: AccessOptions,
): { repoScope: RepoScope } {
  const { hostAllowed, allowedOrigins, authError, repoScope, routes } = rules(listener);
  routes?.(app);

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
