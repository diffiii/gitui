import type { HostInfo } from "@gitui/shared";
import { useSyncExternalStore } from "react";
import { connectToHost, NearbyError, type GuestPeer } from "./peer.ts";
import { rendezvous } from "./rendezvous.ts";

// The page's connection to one nearby host, as an external store: connect, wait for the code,
// then connected, or failed with a reason. One at a time; starting another drops the last.

export type NearbySession =
  | { kind: "idle" }
  | { kind: "connecting"; host: HostInfo; abort: AbortController }
  /** The channel is open and the host wants its code. `attemptsLeft` after a wrong one. */
  | { kind: "code"; host: HostInfo; peer: GuestPeer; checking: boolean; attemptsLeft?: number }
  | { kind: "connected"; host: HostInfo; peer: GuestPeer }
  | { kind: "failed"; host: HostInfo; reason: string };

let session: NearbySession = { kind: "idle" };
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function set(next: NearbySession) {
  session = next;
  listeners.forEach((l) => l());
}

export const useNearbySession = () => useSyncExternalStore(subscribe, () => session);

const reason = (e: unknown) =>
  e instanceof NearbyError ? e.message : `Something went wrong: ${String(e)}`;

/** Connect to `host`, dropping any current connection. */
export async function connect(host: HostInfo) {
  disconnect();
  const abort = new AbortController();
  const connecting: NearbySession = { kind: "connecting", host, abort };
  set(connecting);
  let peer: GuestPeer;
  try {
    peer = await connectToHost(rendezvous(), host, { signal: abort.signal });
  } catch (e) {
    if (session === connecting) set({ kind: "failed", host, reason: reason(e) });
    return;
  }
  if (session !== connecting) return peer.close();
  peer.onClose((why) => {
    if ("peer" in session && session.peer === peer) set({ kind: "failed", host, reason: why });
  });
  set({ kind: "code", host, peer, checking: false });
}

/** Send the code the host printed. */
export async function submitCode(code: string) {
  if (session.kind !== "code" || session.checking) return;
  const checking: NearbySession = { ...session, checking: true };
  set(checking);
  const { host, peer } = checking;
  try {
    const result = await peer.authenticate(code);
    if (session !== checking) return;
    if (result.ok) set({ kind: "connected", host, peer });
    else if (result.attemptsLeft > 0) {
      set({ kind: "code", host, peer, checking: false, attemptsLeft: result.attemptsLeft });
    } else {
      peer.close();
      set({ kind: "failed", host, reason: "Wrong code too many times, so gitui hung up." });
    }
  } catch (e) {
    if (session === checking) set({ kind: "failed", host, reason: reason(e) });
  }
}

/** Drop the connection, or stop connecting. */
export function disconnect() {
  if (session.kind === "connecting") session.abort.abort(new NearbyError("Cancelled."));
  if (session.kind === "code" || session.kind === "connected") session.peer.close();
  if (session.kind !== "idle") set({ kind: "idle" });
}
