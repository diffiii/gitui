import { pairingFragment, parsePairing, type Pairing } from "@gitui/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { rendezvous } from "./nearby/rendezvous.ts";
import { nearbySession, type NearbySession } from "./nearby/session.ts";
import { parseNearbyHost, type NearbyHost } from "./nearby/state.ts";
import { withHeaders } from "./withHeaders.ts";

/**
 * Where API requests go. A page from the Vite dev server (`bun run dev`) is `dev`: it calls its
 * own `/api`, which the dev server proxies to the dev API. Any other page is the hosted app, which
 * calls the CLI on 127.0.0.1 once it is paired with it, until the CLI rejects the pairing's token,
 * or a `gitui --nearby` on a computer of this network over WebRTC once the user picked it
 * (`nearby`: its session holds that link, and ends with the connection).
 */
export type Connection =
  | { kind: "dev" }
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

/** A connection to move to. A nearby host gets its session when the app moves to it. */
export type Target = Exclude<Connection, { kind: "nearby" }> | { kind: "nearby"; host: NearbyHost };

/**
 * The connection a page starts with: `dev` on the dev server, else the saved pairing fragment's,
 * else the saved nearby host (JSON).
 */
export function initialConnection(dev: boolean, saved: string, savedNearby = ""): Target {
  if (dev) return { kind: "dev" };
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

/** How API requests go out: `fetch`, for a path like `/api/config`. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;

/** Where API requests go. Without an accepted pairing there is nowhere to send them. */
export function apiTransport(connection: Connection): Transport {
  switch (connection.kind) {
    case "dev":
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
    case "dev":
      return { kind: "connected" };
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

// Importing the store has no effects: initConnection reads the page's connection, and until
// then it is `unpaired`.
const KEY = "gitui-pairing";
const NEARBY_KEY = "gitui-nearby-host";
let connection: Connection = { kind: "unpaired" };
const listeners = new Set<() => void>();
/** Opens a session with a nearby host. */
let openSession: (host: NearbyHost) => NearbySession = nearbySession;

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

export const getConnection = (): Connection => connection;

export function subscribeConnection(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Move to `next`, opening a session with a nearby host; the host the app is connected to already
 * keeps its session. A session the app moves away from ends, and forgets its token, once the app
 * has moved on, so nothing shows it ending.
 */
function update(next: Target) {
  const previous = connection;
  if (next.kind !== "nearby") connection = next;
  else if (previous.kind === "nearby" && previous.session.host.key === next.host.key) return;
  else connection = { kind: "nearby", session: openSession(next.host) };
  listeners.forEach((l) => l());
  if (previous.kind === "nearby") previous.session.stop();
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
  save(KEY, null);
  save(NEARBY_KEY, host && JSON.stringify(host));
  update(host ? { kind: "nearby", host } : { kind: "unpaired" });
}

/**
 * The connection once the CLI has turned away (401) a request that went out over `used`, or null
 * if that doesn't change it.
 */
export function afterRejection(used: Connection): Target | null {
  switch (used.kind) {
    case "paired":
      return { kind: "rejected", pairing: used.pairing };
    // The dev API takes requests through the dev server's proxy without a token, and the data
    // channel is a nearby session's authentication: a 401 over either is just an error response.
    case "dev":
    case "nearby":
    case "unpaired":
    case "rejected":
      return null;
  }
}

/**
 * Record that the CLI turned away a request that went out over `used`. Ignored once the app has
 * moved on from it, so a stale request can't undo a new pairing.
 */
export function rejectConnection(used: Connection) {
  const next = afterRejection(used);
  if (next && used === getConnection()) update(next);
}

/**
 * Startup wiring. Reads the page's connection (opening the session with a saved nearby host) and
 * drops everything fetched over a connection when it changes. Then the hosted app adopts pairing
 * links opened in this tab, and has a nearby session check its channel when the page is shown
 * again (iOS may have killed it meanwhile). `dev`: the page is on the dev server
 * (`__GITUI_DEV_SERVER__`, set by vite.config.ts). `open`: opens nearby sessions (tests pass another).
 */
export function initConnection(
  queryClient: QueryClient,
  { dev = false, open = nearbySession }: { dev?: boolean; open?: typeof nearbySession } = {},
) {
  openSession = open;
  update(initialConnection(dev, saved(KEY), saved(NEARBY_KEY)));
  subscribeConnection(() => queryClient.clear());
  if (connection.kind === "dev") return;

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
