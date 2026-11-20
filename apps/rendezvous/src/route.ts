// Which Durable Object a WebSocket belongs to. Pure, so the network isolation can be unit-tested
// with injected addresses.
import { HOSTED_ORIGIN, RENDEZVOUS_PATH } from "@gitui/shared";

export type Route = { network: string } | { status: number; message: string };

/** The Worker's vars and secrets that routing reads. */
export interface RouteEnv {
  /** Comma-separated browser origins allowed besides HOSTED_ORIGIN, e.g. a local dev server. */
  ALLOWED_ORIGINS?: string;
  /** HMAC key for object names (networkKey); a wrangler secret, or a --var in `bun run dev`. */
  NETWORK_KEY_SECRET?: string;
}

/**
 * Routes an upgrade to the object of the caller's network, keyed by `CF-Connecting-IP`. A request
 * with an Origin is a browser, and the Origin must be allowed; one without (the CLI) may connect
 * from anywhere. Without NETWORK_KEY_SECRET it fails closed with a 500.
 */
export async function route(request: Request, env: RouteEnv): Promise<Route> {
  if (new URL(request.url).pathname !== RENDEZVOUS_PATH)
    return { status: 404, message: "Not found" };
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return { status: 426, message: "Expected a WebSocket upgrade" };
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && !isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) {
    return { status: 403, message: "Origin not allowed" };
  }
  if (!env.NETWORK_KEY_SECRET) {
    return { status: 500, message: "Misconfigured: the NETWORK_KEY_SECRET secret is not set" };
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const network = await networkKey(ip, env.NETWORK_KEY_SECRET);
  return network ? { network } : { status: 400, message: "Unknown client address" };
}

/** HOSTED_ORIGIN, or one of the comma-separated `allowedOrigins` (e.g. a local dev server). */
export function isAllowedOrigin(origin: string, allowedOrigins: string | undefined): boolean {
  const extra = (allowedOrigins ?? "").split(",").map((allowed) => allowed.trim());
  return origin === HOSTED_ORIGIN || (origin !== "" && extra.includes(origin));
}

/**
 * The HMAC-SHA256 (keyed by `secret`) hex digest of the caller's network: the address for IPv4
 * (IPv4-mapped IPv6 counts as IPv4), the /64 prefix for IPv6. Null if `ip` isn't an address.
 * Object names never show the address, and without the secret they can't be reversed by trying
 * every IPv4 address.
 */
export async function networkKey(ip: string, secret: string): Promise<string | null> {
  const network = networkOf(ip);
  if (network === null) return null;
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(network));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The imported key, reused while the secret stays the same (it does for an isolate's lifetime).
let cached: { secret: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cached?.secret !== secret) {
    const raw = new TextEncoder().encode(secret);
    const key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    cached = { secret, key };
  }
  return cached.key;
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
