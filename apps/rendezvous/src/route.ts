// Which Durable Object a WebSocket belongs to. Pure, so the network isolation can be unit-tested
// with injected addresses.
import { HOSTED_ORIGIN, RENDEZVOUS_PATH } from "@gitui/shared";

export type Route = { network: string } | { status: number; message: string };

/**
 * Routes an upgrade to the object of the caller's network, keyed by `CF-Connecting-IP`. A request
 * with an Origin is a browser, and the Origin must be allowed; one without (the CLI) may connect
 * from anywhere. `allowedOrigins` is the `ALLOWED_ORIGINS` var.
 */
export async function route(request: Request, allowedOrigins: string | undefined): Promise<Route> {
  if (new URL(request.url).pathname !== RENDEZVOUS_PATH)
    return { status: 404, message: "Not found" };
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return { status: 426, message: "Expected a WebSocket upgrade" };
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && !isAllowedOrigin(origin, allowedOrigins)) {
    return { status: 403, message: "Origin not allowed" };
  }
  const network = await networkKey(request.headers.get("CF-Connecting-IP") ?? "");
  return network ? { network } : { status: 400, message: "Unknown client address" };
}

/** HOSTED_ORIGIN, or one of the comma-separated `allowedOrigins` (e.g. a local dev server). */
export function isAllowedOrigin(origin: string, allowedOrigins: string | undefined): boolean {
  const extra = (allowedOrigins ?? "").split(",").map((allowed) => allowed.trim());
  return origin === HOSTED_ORIGIN || (origin !== "" && extra.includes(origin));
}

/**
 * A SHA-256 hex digest of the caller's network: the address for IPv4 (IPv4-mapped IPv6 counts as
 * IPv4), the /64 prefix for IPv6. Null if `ip` isn't an address. The hash keeps raw addresses out
 * of object names, though an IPv4 one can be recovered by trying every address.
 */
export async function networkKey(ip: string): Promise<string | null> {
  const network = networkOf(ip);
  if (network === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(network));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The canonical network of an address: "v4:a.b.c.d" or "v6:a:b:c:d::/64". */
export function networkOf(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return `v4:${v4.join(".")}`;
  const v6 = parseIPv6(ip);
  if (!v6) return null;
  if (v6.slice(0, 6).join(":") === "0:0:0:0:0:65535") {
    const [high, low] = v6.slice(6);
    return `v4:${[high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")}`;
  }
  const prefix = v6.slice(0, 4).map((group) => group.toString(16));
  return `v6:${prefix.join(":")}::/64`;
}

function parseIPv4(ip: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  const octets = match?.slice(1).map(Number);
  return octets?.every((octet) => octet <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address, with `::` expanded. */
function parseIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // A dotted IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = parseIPv4(tail[2]);
    if (!v4) return null;
    const [a, b, c, d] = v4;
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const [head = [], rest = []] = halves.map((half) => (half === "" ? [] : half.split(":")));
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  return groups.every((group) => /^[\da-f]{1,4}$/.test(group))
    ? groups.map((group) => parseInt(group, 16))
    : null;
}
