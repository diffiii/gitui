// Picks the address `gitui --lan` listens on.
import dgram from "node:dgram";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";

/** This machine's IPv4 addresses that other devices may reach: not loopback or link-local. */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
    .map((a) => a.address);
}

/**
 * The local address of the default route, or null without one. Connecting a UDP socket only
 * makes the OS pick a route: nothing is sent, and 192.0.2.1 (TEST-NET-1) is never contacted.
 */
async function defaultRouteAddress(): Promise<string | null> {
  const socket = dgram.createSocket("udp4");
  try {
    socket.connect(9, "192.0.2.1");
    await once(socket, "connect");
    return socket.address().address;
  } catch {
    return null;
  } finally {
    socket.close();
  }
}

/**
 * Private ranges (RFC 1918). Not 100.64.0.0/10: that is carrier-grade NAT's shared space, which
 * other customers of the ISP share, not a LAN. Tailscale addresses are in it, so pass one with
 * `--lan <address>`.
 */
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

const privateRanges = new net.BlockList();
for (const range of PRIVATE_RANGES) {
  const [network, prefix] = range.split("/");
  privateRanges.addSubnet(network, Number(prefix), "ipv4");
}

/**
 * The address to listen on among `candidates`, only ever a private one: `preferred` (the default
 * route's) if it qualifies, else the first that does, else null.
 */
export function chooseLanAddress(candidates: string[], preferred: string | null): string | null {
  const usable = candidates.filter((a) => net.isIPv4(a) && privateRanges.check(a, "ipv4"));
  return preferred && usable.includes(preferred) ? preferred : (usable[0] ?? null);
}

/** The private LAN address to listen on, or null if this machine has none. */
export async function pickLanAddress(): Promise<string | null> {
  return chooseLanAddress(lanAddresses(), await defaultRouteAddress());
}
