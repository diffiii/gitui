import {
  CLIENT_HEADER,
  LOCAL_UI_META,
  pairingFragment,
  parsePairing,
  type Pairing,
} from "@gitui/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * Where API requests go. A page served by gitui itself (the CLI, or the Vite dev server with its
 * `/api` proxy) carries the `LOCAL_UI_META` tag and is `local`: it calls its own origin, whatever
 * its host, until the CLI turns it away. Only `gitui --lan` does, when the page has no session
 * (it wasn't opened through the pairing link, or gitui restarted since): then it is `noSession`.
 * Any other page is the hosted app, which calls the CLI on 127.0.0.1 once it is paired with it,
 * until the CLI rejects the pairing's token.
 */
export type Connection =
  | { kind: "local" }
  | { kind: "noSession" }
  | { kind: "unpaired" }
  | { kind: "paired"; pairing: Pairing }
  | { kind: "rejected"; pairing: Pairing };

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

/**
 * The connection a page starts with: `local` if gitui served it (it has the `LOCAL_UI_META`
 * tag), else the saved pairing fragment's.
 */
export function initialConnection(servedByGitui: boolean, saved: string): Connection {
  if (servedByGitui) return { kind: "local" };
  const pairing = parsePairing(saved);
  return pairing ? { kind: "paired", pairing } : { kind: "unpaired" };
}

/** Base URL and headers of API requests. Without an accepted pairing there is nowhere to send them. */
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
    case "noSession":
    case "unpaired":
    case "rejected":
      throw new ApiError("Not paired with gitui", "unauthorized");
  }
}

/** Retries of the `["config"]` query that gates the app: it polls until a CLI answers. */
export const retryWhileUnreachable = {
  retry: (_failures: number, error: Error) => isApiError(error, "unreachable"),
  retryDelay: 2000,
};

export type ConnectionStatus =
  | { kind: "noSession" }
  | { kind: "unpaired" }
  | { kind: "rejected" }
  | { kind: "connecting"; port: number }
  | { kind: "unreachable"; port: number }
  | { kind: "connected" };

/**
 * What the app shows, from the connection and the `["config"]` query. Any answer, even an error
 * response, means gitui is up, and from then on the app stays up: failed requests show their own
 * errors, and a rejected token changes the connection.
 */
export function connectionStatus(
  connection: Connection,
  config: { dataUpdatedAt: number; errorUpdatedAt: number; failureReason: Error | null },
): ConnectionStatus {
  switch (connection.kind) {
    case "local":
      return { kind: "connected" };
    case "noSession":
    case "unpaired":
    case "rejected":
      return { kind: connection.kind };
    case "paired": {
      if (config.dataUpdatedAt || config.errorUpdatedAt) return { kind: "connected" };
      const { port } = connection.pairing;
      return isApiError(config.failureReason, "unreachable")
        ? { kind: "unreachable", port }
        : { kind: "connecting", port };
    }
  }
}

// The store reads the document and localStorage on first use, so importing it is safe anywhere.
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

const hasLocalUiMeta = () => document.querySelector(`meta[name="${LOCAL_UI_META}"]`) !== null;

export function getConnection(): Connection {
  connection ??= initialConnection(hasLocalUiMeta(), savedPairing());
  return connection;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function update(next: Connection) {
  connection = next;
  listeners.forEach((l) => l());
}

export const useConnection = () => useSyncExternalStore(subscribe, getConnection);

/** Pair the hosted app with a CLI, or forget the pairing with null, and save it for next time. */
export function setPairing(pairing: Pairing | null) {
  try {
    if (pairing) localStorage.setItem(KEY, pairingFragment(pairing));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the pairing lasts for this page load
  }
  update(pairing ? { kind: "paired", pairing } : { kind: "unpaired" });
}

/** The connection once the CLI has turned away (401) a request that went out over `used`. */
export function afterRejection(used: Connection): Connection {
  switch (used.kind) {
    case "local":
      return { kind: "noSession" };
    case "paired":
      return { kind: "rejected", pairing: used.pairing };
    case "noSession":
    case "unpaired":
    case "rejected":
      return used;
  }
}

/**
 * Record that the CLI turned away a request that went out over `used`. Ignored once the app has
 * moved on from it, so a stale request can't undo a new pairing.
 */
export function rejectConnection(used: Connection) {
  const next = afterRejection(used);
  if (next !== used && used === getConnection()) update(next);
}

/**
 * Let a page that lost its session (`noSession`) call its `/api` again, e.g. once its pairing link
 * was opened in another tab, which sets the cookie for this one too. A 401 sends it back to
 * `noSession`; only the user or the page becoming visible again retries, so it can't loop.
 */
export function retrySession() {
  if (getConnection().kind === "noSession") update({ kind: "local" });
}

/**
 * Startup wiring. Reads the page's connection, drops everything fetched over a connection when it
 * changes, and then: a local page retries a lost session whenever it is shown again (a phone
 * opens a scanned pairing link in a new tab, and the user comes back to this one); the hosted app
 * adopts pairing links opened in this tab.
 */
export function initConnection(queryClient: QueryClient) {
  connection = initialConnection(hasLocalUiMeta(), savedPairing());
  subscribe(() => queryClient.clear());

  if (connection.kind === "local") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") retrySession();
    });
    return;
  }

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
}
