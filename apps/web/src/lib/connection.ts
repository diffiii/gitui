import { CLIENT_HEADER, pairingFragment, parsePairing, type Pairing } from "@gitui/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * Where API requests go. A page served from a loopback host (by the CLI, or Vite's dev proxy)
 * is `local` and calls its own origin. Anywhere else is the hosted app, which calls the CLI on
 * 127.0.0.1 once it is paired with it.
 */
export type Connection =
  | { kind: "local" }
  | { kind: "unpaired" }
  | { kind: "paired"; pairing: Pairing };

/**
 * `unreachable`: no CLI answered. `unauthorized`: there is no pairing, or the CLI rejected its
 * token. `http`: any other error response.
 */
export class ApiError extends Error {
  readonly kind: "unreachable" | "unauthorized" | "http";
  constructor(message: string, kind: ApiError["kind"]) {
    super(message);
    this.kind = kind;
  }
}

const isApiError = (e: unknown, kind: ApiError["kind"]) => e instanceof ApiError && e.kind === kind;

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** The connection a page on `hostname` starts with, given the saved pairing fragment. */
export function initialConnection(hostname: string, saved: string): Connection {
  if (isLoopbackHost(hostname)) return { kind: "local" };
  const pairing = parsePairing(saved);
  return pairing ? { kind: "paired", pairing } : { kind: "unpaired" };
}

/** Base URL and headers of API requests. Without a pairing there is nowhere to send them. */
export function apiTarget(connection: Connection): {
  base: string;
  headers: Record<string, string>;
} {
  switch (connection.kind) {
    case "local":
      return { base: "", headers: { [CLIENT_HEADER]: "1" } };
    case "paired":
      return {
        base: `http://127.0.0.1:${connection.pairing.port}`,
        headers: { [CLIENT_HEADER]: "1", authorization: `Bearer ${connection.pairing.token}` },
      };
    case "unpaired":
      throw new ApiError("Not paired with gitui", "unauthorized");
  }
}

export type ConnectionStatus =
  | { kind: "unpaired" }
  | { kind: "rejected" }
  | { kind: "connecting" }
  | { kind: "unreachable"; port: number }
  | { kind: "connected" };

/**
 * What the app shows, from the connection and the `["config"]` query. Once gitui has answered,
 * the app stays up when it stops answering (requests fail with toasts and inline errors), unless
 * it rejects the token.
 */
export function connectionStatus(
  connection: Connection,
  config: { data: unknown; error: Error | null },
): ConnectionStatus {
  switch (connection.kind) {
    case "local":
      return { kind: "connected" };
    case "unpaired":
      return { kind: "unpaired" };
    case "paired":
      if (isApiError(config.error, "unauthorized")) return { kind: "rejected" };
      if (config.data !== undefined) return { kind: "connected" };
      if (!config.error) return { kind: "connecting" };
      // Any other error response came from gitui (the CLI sends CORS headers with it), so it is
      // up and the app can show the error.
      return isApiError(config.error, "unreachable")
        ? { kind: "unreachable", port: connection.pairing.port }
        : { kind: "connected" };
  }
}

// The store reads `location` and localStorage on first use, so importing it is safe anywhere.
const KEY = "gitui-pairing";
let connection: Connection | undefined;
const listeners = new Set<() => void>();

function savedPairing(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function getConnection(): Connection {
  connection ??= initialConnection(location.hostname, savedPairing());
  return connection;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const useConnection = () => useSyncExternalStore(subscribe, getConnection);

/** Pair the hosted app with a CLI, or forget the pairing with null, and save it for next time. */
export function setPairing(pairing: Pairing | null) {
  const next: Connection = pairing ? { kind: "paired", pairing } : { kind: "unpaired" };
  if (JSON.stringify(next) === JSON.stringify(getConnection())) return;
  connection = next;
  try {
    if (pairing) localStorage.setItem(KEY, pairingFragment(pairing));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the pairing lasts for this page load
  }
  listeners.forEach((l) => l());
}

/**
 * Startup wiring of the hosted app; a local page needs none. Adopts pairing links opened in this
 * tab, drops everything fetched over a pairing when it changes, and rechecks the config when any
 * request is unauthorized, so a revoked token leads straight to the pair screen.
 */
export function initConnection(queryClient: QueryClient) {
  if (getConnection().kind === "local") return;

  // Take the pairing out of the address bar and history, keeping the query string the app keeps
  // its state in.
  const adoptHash = () => {
    if (!location.hash) return;
    const pairing = parsePairing(location.hash);
    history.replaceState(history.state, "", location.pathname + location.search);
    if (pairing) setPairing(pairing);
  };
  adoptHash();
  addEventListener("hashchange", adoptHash);
  subscribe(() => queryClient.clear());

  const recheck = (error: unknown) => {
    const rejected = isApiError(queryClient.getQueryState(["config"])?.error, "unauthorized");
    if (isApiError(error, "unauthorized") && !rejected) {
      void queryClient.refetchQueries({ queryKey: ["config"] });
    }
  };
  queryClient.getQueryCache().subscribe((e) => {
    if (e.type === "updated" && e.action.type === "error") recheck(e.action.error);
  });
  queryClient.getMutationCache().subscribe((e) => {
    if (e.type === "updated" && e.action.type === "error") recheck(e.action.error);
  });
}
