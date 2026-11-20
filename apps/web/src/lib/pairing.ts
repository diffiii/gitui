import { pairingUrl, parsePairing, type Pairing } from "@gitui/shared";
import { useSyncExternalStore } from "react";
import { isLoopbackHost, pairingFromLink } from "./connection.ts";

/** Whether this is the hosted app, which reaches the CLI through a pairing. */
export const hosted = !isLoopbackHost(location.hostname);

// The saved pairing is stored as the link gitui prints, so loading it reuses the link parser.
const KEY = "gitui-pairing";

function load(): Pairing | null {
  try {
    return pairingFromLink(localStorage.getItem(KEY) ?? "");
  } catch {
    return null;
  }
}

let pairing = hosted ? load() : null;
const listeners = new Set<() => void>();

/** Replace (or forget, with null) the pairing and save it for the next visit. */
export function setPairing(next: Pairing | null) {
  pairing = next;
  try {
    if (next) localStorage.setItem(KEY, pairingUrl(location.origin, next));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the pairing lasts for this page load
  }
  listeners.forEach((l) => l());
}

export const getPairing = () => pairing;

export function subscribePairing(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const usePairing = () => useSyncExternalStore(subscribePairing, getPairing);

// Adopt a pairing link opened in this tab, then drop the token from the address bar and
// history, keeping the query string the app keeps its state in.
function adoptHash() {
  if (!location.hash) return;
  const next = parsePairing(location.hash);
  history.replaceState(history.state, "", location.pathname + location.search);
  if (next) setPairing(next);
}
if (hosted) {
  adoptHash();
  addEventListener("hashchange", adoptHash);
}
