// How the web app reaches the gitui CLI, shared by both sides.

/** Port the CLI tries first; it takes the next free one if this is in use. */
export const DEFAULT_PORT = 4777;

/** Header every API request carries. Cross-origin pages can't send it without a CORS preflight. */
export const CLIENT_HEADER = "x-gitui";

/**
 * @deprecated The web app no longer reads this `<meta>` tag (the dev server's pages are told by
 * `import.meta.env.DEV`); only the CLI's `scripts/local-ui.ts` still writes it. Remove with it.
 */
export const LOCAL_UI_META = "gitui-local-ui";

/** Origin of the hosted web app, the only cross-origin page the CLI accepts by default. */
export const HOSTED_ORIGIN = "https://gitui.diffiii.dev";

/** Hostnames that only reach this machine, spelled as in `location.hostname` and `Host`. */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.includes(hostname);

/** What the hosted app needs to reach a CLI: its port and pairing token. */
export interface Pairing {
  port: number;
  token: string;
}

/** The URL fragment (`#port=…&token=…`) that carries a pairing. */
export function pairingFragment({ port, token }: Pairing): string {
  return `#${new URLSearchParams({ port: String(port), token }).toString()}`;
}

/**
 * The link the CLI prints to open the hosted app. The pairing travels in the URL fragment,
 * which browsers never send to the server.
 */
export function pairingUrl(origin: string, pairing: Pairing): string {
  return `${origin}/${pairingFragment(pairing)}`;
}

/**
 * Read a pairing from what follows the first `#` in `link`: `location.hash`, a whole pairing
 * link or a saved fragment. Null if it has no valid pairing.
 */
export function parsePairing(link: string): Pairing | null {
  const i = link.indexOf("#");
  if (i < 0) return null;
  const sp = new URLSearchParams(link.slice(i + 1));
  const port = Number(sp.get("port"));
  const token = sp.get("token");
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, token };
}
