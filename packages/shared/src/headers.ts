import { RENDEZVOUS_ORIGIN } from "./nearby.ts";
import { rendezvousUrl } from "./nearby-codec.ts";

// Security headers of the web app's pages, wherever they are served from.

/**
 * Headers for every UI response. `connectSrc` is the CSP connect-src: where the page may send
 * requests (its own origin for the CLI's bundled UI; the CLI on 127.0.0.1 and the rendezvous too
 * for the hosted app). It doesn't govern WebRTC, so it needn't list STUN servers or peers.
 */
export function uiSecurityHeaders(connectSrc: string): Record<string, string> {
  return {
    "Content-Security-Policy": `script-src 'self'; connect-src ${connectSrc}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * The hosted app's `_headers` file (Cloudflare's format: a path pattern, then its headers
 * indented), which the web build emits next to the UI. `rendezvousOrigin` is the build's
 * rendezvous (VITE_GITUI_RENDEZVOUS_URL, e.g. a test deployment's); it must be a ws: or wss:
 * origin, since it goes into the CSP as is.
 */
export function hostedHeadersFile(rendezvousOrigin = RENDEZVOUS_ORIGIN): string {
  if (rendezvousUrl(rendezvousOrigin) === null) {
    throw new Error(`The rendezvous URL must be a ws: or wss: origin, not ${rendezvousOrigin}`);
  }
  const headers = uiSecurityHeaders(`'self' http://127.0.0.1:* ${rendezvousOrigin}`);
  return ["/*", ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ""].join(
    "\n",
  );
}
