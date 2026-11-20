// Who may call the API. Requests must be addressed to localhost (defends against DNS rebinding)
// and carry the client header, which cross-origin pages can't send without a CORS preflight.
// GETs need it too: they run git in the requested directory. Same-origin requests (no Origin, or
// the server's own) need nothing else. Allowed cross-origin pages, like the hosted web app, get
// CORS headers and must also send the pairing token. Any other origin is refused.
import { timingSafeEqual } from "node:crypto";
import { CLIENT_HEADER } from "@gitui/shared";
import { createMiddleware } from "hono/factory";

export interface AccessOptions {
  /** Cross-origin pages allowed to call the API, e.g. HOSTED_ORIGIN. */
  allowedOrigins: string[];
  /** Pairing token cross-origin pages must send as `Authorization: Bearer <token>`. */
  token: string;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function apiAccess({ allowedOrigins, token }: AccessOptions) {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (header = "") => {
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  return createMiddleware(async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!LOCAL_HOSTS.includes(host.replace(/:\d+$/, ""))) return c.text("Forbidden host", 403);

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
    // A JSON 401 with CORS headers lets the page tell "not paired" from "CLI not running".
    if (crossOrigin && !authorized(c.req.header("authorization"))) {
      return c.json({ error: "Missing or invalid pairing token" }, 401);
    }
    await next();
  });
}
