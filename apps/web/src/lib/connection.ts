// Window-free connection logic, kept apart from the pairing store so it can be unit-tested.
import { CLIENT_HEADER, parsePairing, type Pairing } from "@gitui/shared";

/**
 * Pages served from a loopback host (by the CLI, or Vite's dev proxy) reach the API on their
 * own origin. Anywhere else is the hosted app, which needs a pairing with a running CLI.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Where API requests go and the headers they carry: same-origin without a pairing. */
export function apiTarget(pairing: Pairing | null): {
  base: string;
  headers: Record<string, string>;
} {
  if (!pairing) return { base: "", headers: { [CLIENT_HEADER]: "1" } };
  return {
    base: `http://127.0.0.1:${pairing.port}`,
    headers: { [CLIENT_HEADER]: "1", authorization: `Bearer ${pairing.token}` },
  };
}

/** Read a pairing from a link gitui printed (anything ending in its `#port=…&token=…`). */
export function pairingFromLink(link: string): Pairing | null {
  const i = link.indexOf("#");
  return i < 0 ? null : parsePairing(link.slice(i));
}
