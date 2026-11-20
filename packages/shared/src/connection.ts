// How the web app reaches the gitui CLI, shared by both sides.

/** Port the CLI tries first; it takes the next free one if this is in use. */
export const DEFAULT_PORT = 4777;

/** Header every API request carries. Cross-origin pages can't send it without a CORS preflight. */
export const CLIENT_HEADER = "x-gitui";

/** Origin of the hosted web app, the only cross-origin page the CLI accepts by default. */
export const HOSTED_ORIGIN = "https://gitui.diffiii.workers.dev";

/** What the hosted app needs to reach a CLI: its port and pairing token. */
export interface Pairing {
  port: number;
  token: string;
}

/**
 * The link the CLI prints to open the hosted app. The pairing travels in the URL fragment,
 * which browsers never send to the server.
 */
export function pairingUrl(origin: string, { port, token }: Pairing): string {
  return `${origin}/#${new URLSearchParams({ port: String(port), token }).toString()}`;
}

/** Read a pairing from a URL fragment (`location.hash`); null if it has none. */
export function parsePairing(hash: string): Pairing | null {
  const sp = new URLSearchParams(hash.replace(/^#/, ""));
  const port = Number(sp.get("port"));
  const token = sp.get("token");
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, token };
}
