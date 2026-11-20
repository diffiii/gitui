import {
  CLIENT_HEADER,
  LOCAL_UI_META,
  pairingFragment,
  parsePairing,
  type Pairing,
} from "@gitui/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { parseNearbyHost, type NearbyHost, type NearbyState } from "./nearby/state.ts";
import { tokens } from "./nearby/tokens.ts";

/**
 * Where API requests go. A page served by gitui itself (the CLI, or the Vite dev server with its
 * `/api` proxy) carries the `LOCAL_UI_META` tag and is `local`: it calls its own origin, whatever
 * its host, until the CLI turns it away. Only `gitui --lan` does, when the page has no session
 * (it wasn't opened through the pairing link, or gitui restarted since): then it is `noSession`.
 * Any other page is the hosted app, which calls the CLI on 127.0.0.1 once it is paired with it,
 * until the CLI rejects the pairing's token, or a `gitui --nearby` on another computer of this
 * network over WebRTC once the user picked it (`nearby`; nearby/session.ts holds that link).
 */
export type Connection =
  | { kind: "local" }
  | { kind: "noSession" }
  | { kind: "unpaired" }
  | { kind: "paired"; pairing: Pairing }
  | { kind: "rejected"; pairing: Pairing }
  | { kind: "nearby"; host: NearbyHost };

/**
 * `unreachable`: no CLI answered. `unauthorized`: there is no pairing, or the CLI rejected its
 * token. `not-opened`: this device may only use repositories opened on the computer running
 * gitui, and this isn't one (REPO_NOT_OPENED). `http`: any other error response.
 */
export class ApiError extends Error {
  readonly kind: "unreachable" | "unauthorized" | "not-opened" | "http";
  constructor(message: string, kind: ApiError["kind"]) {
    super(message);
    this.kind = kind;
  }
}

export const isApiError = (e: unknown, kind: ApiError["kind"]) =>
  e instanceof ApiError && e.kind === kind;

/**
 * The connection a page starts with: `local` if gitui served it (it has the `LOCAL_UI_META`
 * tag), else the saved pairing fragment's, else the saved nearby host's (JSON).
 */
export function initialConnection(
  servedByGitui: boolean,
  saved: string,
  savedNearby = "",
): Connection {
  if (servedByGitui) return { kind: "local" };
  const pairing = parsePairing(saved);
  if (pairing) return { kind: "paired", pairing };
  const host = parseSavedHost(savedNearby);
  return host ? { kind: "nearby", host } : { kind: "unpaired" };
}

function parseSavedHost(saved: string): NearbyHost | null {
  try {
    return parseNearbyHost(JSON.parse(saved));
  } catch {
    return null;
  }
}

/** Base URL and headers of API requests. Without an accepted pairing there is nowhere to send them. */
export function apiTarget(connection: Connection): {
  base: string;
  headers: Record<string, string>;
} {
  switch (connection.kind) {
    case "local":
    // Paths on the host; the data channel is the authentication.
    case "nearby":
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
  | { kind: "connected" }
  /** Opening the data channel to a nearby host, or resuming the session with it. */
  | { kind: "nearbyConnecting"; host: string }
  | {
      kind: "nearbyCode";
      host: string;
      checking: boolean;
      attemptsLeft?: number;
      notice?: "expired" | "restarted";
    }
  /** Connected, but the nearby session dropped and is coming back; the app stays up. */
  | { kind: "reconnecting"; host: string }
  | { kind: "nearbyFailed"; host: string; reason: string };

/**
 * What the app shows, from the connection and the `["config"]` query, or for a nearby host from
 * its session. Any answer, even an error response, means gitui is up, and from then on the app
 * stays up: failed requests show their own errors, and a rejected token changes the connection.
 */
export function connectionStatus(
  connection: Connection,
  config: { dataUpdatedAt: number; errorUpdatedAt: number; failureReason: Error | null },
  nearby: NearbyState = { kind: "off" },
): ConnectionStatus {
  switch (connection.kind) {
    case "nearby":
      return nearbyStatus(connection.host, nearby);
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

/** The status of a nearby connection to `host`, from the session's state. */
export function nearbyStatus(host: NearbyHost, nearby: NearbyState): ConnectionStatus {
  // The session catches up with the connection synchronously; until it has, it's connecting.
  if (nearby.kind === "off" || nearby.host.key !== host.key) {
    return { kind: "nearbyConnecting", host: host.name };
  }
  const name = nearby.host.name;
  switch (nearby.kind) {
    case "connecting":
      return { kind: "nearbyConnecting", host: name };
    case "code": {
      const { checking, attemptsLeft, notice } = nearby;
      return {
        kind: "nearbyCode",
        host: name,
        checking,
        ...(attemptsLeft !== undefined && { attemptsLeft }),
        ...(notice && { notice }),
      };
    }
    case "connected":
      return { kind: "connected" };
    case "reconnecting":
      return { kind: "reconnecting", host: name };
    case "failed":
      return { kind: "nearbyFailed", host: name, reason: nearby.reason };
  }
}

// The store reads the document and localStorage on first use, so importing it is safe anywhere.
const KEY = "gitui-pairing";
const NEARBY_KEY = "gitui-nearby-host";
let connection: Connection | undefined;
const listeners = new Set<() => void>();

function saved(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Save `value` under `key`, or remove it for null. */
function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the connection lasts for this page load
  }
}

const savedConnection = () => initialConnection(hasLocalUiMeta(), saved(KEY), saved(NEARBY_KEY));

const hasLocalUiMeta = () => document.querySelector(`meta[name="${LOCAL_UI_META}"]`) !== null;

export function getConnection(): Connection {
  connection ??= savedConnection();
  return connection;
}

export function subscribeConnection(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function update(next: Connection) {
  connection = next;
  listeners.forEach((l) => l());
}

export const useConnection = () => useSyncExternalStore(subscribeConnection, getConnection);

/**
 * Forgetting what the hosted app is connected to: whom it disconnects from (e.g. "gitui on port
 * 4778", or a nearby host's name) and a function that does, or null outside the hosted app.
 */
export function useDisconnect(): { target: string; disconnect: () => void } | null {
  const connection = useConnection();
  switch (connection.kind) {
    case "paired":
      return {
        target: `gitui on port ${connection.pairing.port}`,
        disconnect: () => setPairing(null),
      };
    case "nearby":
      return { target: connection.host.name, disconnect: () => setNearbyHost(null) };
    default:
      return null;
  }
}

/** Forget the nearby host's resume token, unless the app stays connected to it (`next`). */
function forgetNearbyToken(next?: NearbyHost | null) {
  const current = getConnection();
  if (current.kind === "nearby" && current.host.key !== next?.key) tokens.forget(current.host.key);
}

/** Pair the hosted app with a CLI, or forget the pairing with null, and save it for next time. */
export function setPairing(pairing: Pairing | null) {
  forgetNearbyToken();
  save(NEARBY_KEY, null);
  save(KEY, pairing && pairingFragment(pairing));
  update(pairing ? { kind: "paired", pairing } : { kind: "unpaired" });
}

/**
 * Connect the hosted app to a nearby host, or forget it (and its resume token) with null, and
 * save it, so a reload resumes the session with it.
 */
export function setNearbyHost(host: NearbyHost | null) {
  forgetNearbyToken(host);
  save(KEY, null);
  save(NEARBY_KEY, host && JSON.stringify(host));
  update(host ? { kind: "nearby", host } : { kind: "unpaired" });
}

/** The connection once the CLI has turned away (401) a request that went out over `used`. */
export function afterRejection(used: Connection): Connection {
  switch (used.kind) {
    case "local":
      return { kind: "noSession" };
    case "paired":
      return { kind: "rejected", pairing: used.pairing };
    // The data channel is the authentication; a 401 over it is just an error response.
    case "nearby":
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
  connection = savedConnection();
  subscribeConnection(() => queryClient.clear());

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
