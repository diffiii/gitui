import { RENDEZVOUS_ORIGIN, rendezvousUrl } from "./nearby.ts";

/**
 * The hosted app's `_headers` file (Cloudflare's format: a path pattern, then its headers
 * indented), which the web build emits next to the UI. `rendezvousOrigin` is the build's
 * rendezvous (VITE_GITUI_RENDEZVOUS_URL, e.g. a test deployment's); it must be a ws: or wss:
 * origin, since it goes into the CSP as is. The page may send requests to its own origin, the
 * CLI on 127.0.0.1 and the rendezvous; connect-src doesn't govern WebRTC, so it needn't list STUN
 * servers or peers.
 */
export function hostedHeadersFile(rendezvousOrigin = RENDEZVOUS_ORIGIN): string {
  if (rendezvousUrl(rendezvousOrigin) === null) {
    throw new Error(`The rendezvous URL must be a ws: or wss: origin, not ${rendezvousOrigin}`);
  }
  const headers = {
    "Content-Security-Policy": `script-src 'self'; connect-src 'self' http://127.0.0.1:* ${rendezvousOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  return ["/*", ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ""].join(
    "\n",
  );
}
