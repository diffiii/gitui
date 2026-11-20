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
//   HTTP, so it is not the pairing token and can't pair the hosted app.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CLIENT_HEADER, isLoopbackHost } from "@gitui/shared";
import type { Context, Env, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

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
}

export type Listener = LoopbackListener | LanListener;

export interface AccessOptions {
  listener: Listener;
  /** The port the server listens on; a LAN listener only accepts `<address>:<port>` as Host. */
  port: number;
}

/** A LAN listener on `address`, with a fresh secret. */
export const lanListener = (address: string): LanListener => ({
  kind: "lan",
  address,
  secret: randomBytes(32).toString("base64url"),
});

/** The address to bind for `listener`. */
export const listenAddress = (listener: Listener) =>
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
function safeEqual(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What a listener lets through; `authError` is why a request may not proceed, if it may not. */
interface Rules {
  hostAllowed: (host: string) => boolean;
  allowedOrigins: string[];
  authError: (c: Context, crossOrigin: boolean) => string | null;
}

const isLoopback = (host: string) => isLoopbackHost(host.replace(/:\d+$/, ""));

// Cookies ignore ports, so another gitui on this address must not overwrite this one's.
const sessionCookie = (port: number) => `gitui-session-${port}`;

function rules({ listener, port }: AccessOptions): Rules {
  if (listener.kind === "loopback") {
    const bearer = `Bearer ${listener.token}`;
    return {
      hostAllowed: isLoopback,
      allowedOrigins: listener.allowedOrigins,
      authError: (c, crossOrigin) =>
        !crossOrigin || safeEqual(c.req.header("authorization") ?? "", bearer)
          ? null
          : "Missing or invalid pairing token",
    };
  }
  const lanHost = `${listener.address}:${port}`;
  return {
    // Loopback Hosts too, for a LAN listener on 127.0.0.1.
    hostAllowed: (host) => host === lanHost || isLoopback(host),
    allowedOrigins: [],
    authError: (c) =>
      safeEqual(getCookie(c, sessionCookie(port)) ?? "", listener.secret)
        ? null
        : "Not paired: open the link gitui printed",
  };
}

/** Adds the access checks to `/api/*`, and the `/pair` route for a LAN listener. */
export function installAccess<E extends Env>(app: Hono<E>, opts: AccessOptions) {
  const { hostAllowed, allowedOrigins, authError } = rules(opts);
  const { listener, port } = opts;

  if (listener.kind === "lan") {
    app.get("/pair", (c) => {
      if (!hostAllowed(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
      if (!safeEqual(c.req.query("key") ?? "", listener.secret)) {
        return c.text("Invalid pairing key: open the link gitui printed", 403);
      }
      setCookie(c, sessionCookie(port), listener.secret, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
      });
      return c.redirect("/");
    });
  }

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
}
