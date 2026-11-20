// Picks the address `gitui --lan` listens on.
import dgram from "node:dgram";
import { once } from "node:events";
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

/** The LAN address to listen on: the default route's, else the first one found, else null. */
export async function pickLanAddress(): Promise<string | null> {
  const candidates = lanAddresses();
  const preferred = await defaultRouteAddress();
  return preferred && candidates.includes(preferred) ? preferred : (candidates[0] ?? null);
}
