import {
  CLIENT_HEADER,
  LOCAL_UI_META,
  pairingFragment,
  parsePairing,
  type Pairing,
} from "@gitui/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { rendezvous } from "./nearby/rendezvous.ts";
import { nearbySession, type NearbySession } from "./nearby/session.ts";
import { parseNearbyHost, type NearbyHost } from "./nearby/state.ts";

/**
 * Where API requests go. A page served by gitui itself (the CLI, or the Vite dev server with its
 * `/api` proxy) carries the `LOCAL_UI_META` tag and is `local`: it calls its own origin, whatever
 * its host, until the CLI turns it away. Only `gitui --lan` does, when the page has no session
 * (it wasn't opened through the pairing link, or gitui restarted since): then it is `noSession`.
 * Any other page is the hosted app, which calls the CLI on 127.0.0.1 once it is paired with it,
 * until the CLI rejects the pairing's token, or a `gitui --nearby` on another computer of this
 * network over WebRTC once the user picked it (`nearby`: its session holds that link, and ends
 * with the connection).
 */
export type Connection =
  | { kind: "local" }
  | { kind: "noSession" }
  | { kind: "unpaired" }
  | { kind: "paired"; pairing: Pairing }
  | { kind: "rejected"; pairing: Pairing }
  | { kind: "nearby"; session: NearbySession };

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
 * tag), else the saved pairing fragment's, else a session (`open`) with the saved nearby host
 * (JSON).
 */
export function initialConnection(
  servedByGitui: boolean,
  saved: string,
  savedNearby = "",
  open: (host: NearbyHost) => NearbySession = (host) => openNearby(host),
): Connection {
  if (servedByGitui) return { kind: "local" };
  const pairing = parsePairing(saved);
  if (pairing) return { kind: "paired", pairing };
  const host = parseSavedHost(savedNearby);
  return host ? { kind: "nearby", session: open(host) } : { kind: "unpaired" };
}

function parseSavedHost(saved: string): NearbyHost | null {
  try {
    return parseNearbyHost(JSON.parse(saved));
  } catch {
    return null;
  }
}

/** How API requests go out: `fetch`, for a path like `/api/config`. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;

/** `init` with the client header, and `extra` headers. */
function withHeaders(init: RequestInit, extra: Record<string, string> = {}): RequestInit {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries({ [CLIENT_HEADER]: "1", ...extra })) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

/** Where API requests go. Without an accepted pairing there is nowhere to send them. */
export function apiTransport(connection: Connection): Transport {
  switch (connection.kind) {
    case "local":
      return (path, init) => fetch(path, withHeaders(init));
    case "nearby": {
      // Over the session's data channel, which is the authentication.
      const { session } = connection;
      return (path, init) => session.fetch(path, withHeaders(init));
    }
    case "paired": {
      const { port, token } = connection.pairing;
      return (path, init) =>
        fetch(
          `http://127.0.0.1:${port}${path}`,
          withHeaders(init, { authorization: `Bearer ${token}` }),
        );
    }
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
  /** A nearby host: its session's state says the rest. */
  | { kind: "nearby"; session: NearbySession };

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
    case "nearby":
      return connection;
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
const NEARBY_KEY = "gitui-nearby-host";
let connection: Connection | undefined;
const listeners = new Set<() => void>();
/** Starts a session with a nearby host; initConnection wires it to the query client. */
let openNearby = (host: NearbyHost) => nearbySession(host, () => {});

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

/** Move to `next`. A nearby session the app moves away from ends, and forgets its token. */
function update(next: Connection) {
  const previous = connection;
  if (
    previous?.kind === "nearby" &&
    (next.kind !== "nearby" || next.session !== previous.session)
  ) {
    previous.session.stop();
  }
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
      return { target: connection.session.host.name, disconnect: () => setNearbyHost(null) };
    default:
      return null;
  }
}

/** Pair the hosted app with a CLI, or forget the pairing with null, and save it for next time. */
export function setPairing(pairing: Pairing | null) {
  save(NEARBY_KEY, null);
  save(KEY, pairing && pairingFragment(pairing));
  update(pairing ? { kind: "paired", pairing } : { kind: "unpaired" });
}

/**
 * Connect the hosted app to a nearby host, or forget it (and its resume token) with null, and
 * save it, so a reload resumes the session with it. The host it is connected to already keeps
 * its session.
 */
export function setNearbyHost(host: NearbyHost | null) {
  const current = getConnection();
  if (host && current.kind === "nearby" && current.session.host.key === host.key) return;
  save(KEY, null);
  save(NEARBY_KEY, host && JSON.stringify(host));
  update(host ? { kind: "nearby", session: openNearby(host) } : { kind: "unpaired" });
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
 * adopts pairing links opened in this tab, and has a nearby session check its channel when the
 * page is shown again (iOS may have killed it meanwhile).
 */
export function initConnection(queryClient: QueryClient, open = nearbySession) {
  openNearby = (host) => open(host, () => void queryClient.invalidateQueries());
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

  const wake = () => {
    const current = getConnection();
    if (current.kind === "nearby") current.session.wake();
    else rendezvous().wake();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) wake();
  });
}
