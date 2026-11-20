import { CLIENT_HEADER, type HostInfo } from "@gitui/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  getConnection,
  setNearbyHost,
  subscribeConnection,
  type Connection,
} from "../connection.ts";
import { CONNECT_TIMEOUT, connectToHost, NearbyError, type GuestPeer } from "./peer.ts";
import { rendezvous } from "./rendezvous.ts";
import {
  afterRejectedResume,
  findHost,
  opening,
  type NearbyHost,
  type NearbyState,
} from "./state.ts";
import { tokens } from "./tokens.ts";

// The page's session with the nearby host its connection names, as an external store
// (NearbyState). It follows the connection store: a `nearby` connection starts a session, any
// other ends it. A session finds its host on the rendezvous by key, opens a data channel, and
// resumes with the saved token or asks for the code. When a connected session drops (the channel
// closes, the rendezvous socket drops, so the host drops us, or the page comes back from the
// background with a dead channel) it reconnects in the background: a new socket if needed, a
// new offer, and `resume`.
//
// Requests during a reconnect: the ones in flight fail as soon as the channel is known dead (the
// host may or may not have run them, so they can't be safely sent again); new ones wait for the
// session to come back, up to REQUEST_WAIT; and once it is back every query is refetched, which
// replaces the errors the failed ones left.

/** How long connecting, or reconnecting, keeps trying before it gives up. */
export const RETRY_WINDOW = 20_000;
/** How long a request made while the session is (re)connecting waits for it. */
export const REQUEST_WAIT = 15_000;
/** How long the channel may take to answer the check made when the page is shown again. */
const PROBE_TIMEOUT = 4000;

let state: NearbyState = { kind: "off" };
const listeners = new Set<() => void>();

function set(next: NearbyState) {
  state = next;
  listeners.forEach((l) => l());
}

export const getNearbyState = () => state;

export function subscribeNearby(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useNearbySession = () => useSyncExternalStore(subscribeNearby, getNearbyState);

/** The session with one host, from when the connection names it until it no longer does. */
interface Run {
  /** Changes only when the host restarted (a new key), along with the connection. */
  host: NearbyHost;
  /** Aborts the step in progress: waiting for the host, connecting, a pause between attempts. */
  attempt: AbortController;
  /** The open data channel, from the moment it opens. */
  peer: GuestPeer | null;
  /** Whether it was connected before, so coming back refetches what failed meanwhile. */
  wasConnected: boolean;
  /** Ends the pause between attempts early. */
  kick: (() => void) | null;
  stopRendezvous: () => void;
}

let run: Run | null = null;
let onReconnected = () => {};

const reason = (e: unknown) =>
  e instanceof NearbyError ? e.message : `Something went wrong: ${String(e)}`;

/** Start or end the session to match the connection. */
function follow(connection: Connection) {
  if (connection.kind !== "nearby") return stop();
  if (run?.host.key === connection.host.key) return;
  stop();
  start(connection.host);
}

function start(host: NearbyHost) {
  const r: Run = {
    host,
    attempt: new AbortController(),
    peer: null,
    wasConnected: false,
    kick: null,
    stopRendezvous: () => {},
  };
  run = r;
  // The session holds the rendezvous socket for as long as it lasts: the host ends a session as
  // soon as its guest's socket is gone, so when ours drops, so does the channel. And when the
  // host leaves the list (it quit, or restarted), its channel may be dead without a word.
  const client = rendezvous();
  let wasOpen = client.getSnapshot().status === "open";
  let wasListed = true;
  r.stopRendezvous = client.subscribe(() => {
    const { status, hosts } = client.getSnapshot();
    const open = status === "open";
    if (wasOpen && !open && r.peer) lost(r);
    wasOpen = open;
    const listed = !open || findHost(hosts, r.host).kind === "listed";
    if (wasListed && !listed) probe(r);
    wasListed = listed;
  });
  void establish(r, "connecting");
}

function stop() {
  const r = run;
  if (!r) return;
  run = null;
  r.attempt.abort(new NearbyError("Disconnected."));
  r.peer?.close();
  r.peer = null;
  r.stopRendezvous();
  set({ kind: "off" });
}

/**
 * Open a session with the run's host, trying again until RETRY_WINDOW is up. `connecting` blocks
 * the app; `reconnecting` keeps it up. `notice` tells the code screen why it asks again.
 */
async function establish(
  r: Run,
  mode: "connecting" | "reconnecting",
  notice?: "expired" | "restarted",
): Promise<void> {
  r.attempt.abort();
  const { signal } = (r.attempt = new AbortController());
  r.peer?.close();
  r.peer = null;
  set({ kind: mode, host: r.host });
  const deadline = Date.now() + RETRY_WINDOW;
  for (let failures = 0; ; failures++) {
    try {
      const { host, restarted } = await locate(r, deadline, signal);
      const timeout = Math.max(2000, Math.min(CONNECT_TIMEOUT, deadline - Date.now()));
      const peer = await connectToHost(rendezvous(), host, { signal, timeout });
      if (signal.aborted) return peer.close();
      return await authenticate(r, peer, restarted ? "restarted" : notice);
    } catch (e) {
      if (signal.aborted || run !== r) return;
      if (Date.now() >= deadline) return set({ kind: "failed", host: r.host, reason: reason(e) });
      await pause(r, Math.min(4000, 500 * 2 ** failures), signal);
      if (signal.aborted) return;
    }
  }
}

/**
 * Wait until the rendezvous lists the run's host, or the new run of a host that restarted, which
 * the session then follows (and the connection with it). Rejects at `deadline`.
 */
function locate(
  r: Run,
  deadline: number,
  signal: AbortSignal,
): Promise<{ host: HostInfo; restarted: boolean }> {
  const client = rendezvous();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      done();
      reject(signal.reason);
    };
    const check = () => {
      const { status, hosts } = client.getSnapshot();
      if (status !== "open") return;
      const found = findHost(hosts, r.host);
      if (found.kind === "missing") return;
      done();
      if (found.kind === "restarted") {
        // Its tokens went with the old run. Switch first, so following the connection keeps us.
        r.host = { key: found.host.key, name: found.host.name };
        setNearbyHost(r.host);
      }
      resolve({ host: found.host, restarted: found.kind === "restarted" });
    };
    const timer = setTimeout(() => {
      done();
      reject(
        new NearbyError(
          client.getSnapshot().status === "open"
            ? `Can't find ${r.host.name} on this network. Is gitui still running there with --nearby?`
            : "Can't reach the rendezvous server. Check your connection and try again.",
        ),
      );
    }, deadline - Date.now());
    const unsubscribe = client.subscribe(check);
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

function pause(r: Run, ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      r.kick = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    r.kick = done;
  });
}

/** Resume on a new channel with the saved token, or ask for the code. */
async function authenticate(
  r: Run,
  peer: GuestPeer,
  notice?: "expired" | "restarted",
): Promise<void> {
  r.peer = peer;
  const { key } = r.host;
  peer.onSession((token) => tokens.save(key, token));
  peer.onClose(() => {
    if (r.peer === peer) lost(r);
  });
  const move = opening(tokens.load(key));
  if (move.t === "auth") return set({ kind: "code", host: r.host, checking: false, notice });
  const result = await peer.resume(move.token);
  if (r.peer !== peer) return;
  if (result.ok) return connected(r);
  // The host no longer knows the token (it was made by a CLI run that ended, or it expired).
  tokens.forget(key);
  if (afterRejectedResume(result.attemptsLeft) === "reopen") {
    return establish(r, "connecting", "expired");
  }
  set({ kind: "code", host: r.host, checking: false, notice: notice ?? "expired" });
}

function connected(r: Run) {
  set({ kind: "connected", host: r.host });
  if (r.wasConnected) onReconnected();
  r.wasConnected = true;
}

/** The channel is gone: reconnect in the background if it was connected. */
function lost(r: Run) {
  if (run !== r) return;
  r.peer?.close();
  r.peer = null;
  if (state.kind === "connected") void establish(r, "reconnecting");
  // Waiting for the code: open a new channel to ask on. While a code is being checked,
  // submitCode hears about the closed channel itself.
  else if (state.kind === "code" && !state.checking) void establish(r, "connecting", state.notice);
}

/** Send the code the host printed. */
export async function submitCode(code: string) {
  const r = run;
  const peer = r?.peer;
  if (!r || !peer || state.kind !== "code" || state.checking) return;
  set({ ...state, checking: true });
  try {
    const result = await peer.authenticate(code);
    if (r.peer !== peer) return;
    if (result.ok) return connected(r);
    if (result.attemptsLeft > 0) {
      return set({
        kind: "code",
        host: r.host,
        checking: false,
        attemptsLeft: result.attemptsLeft,
      });
    }
    r.peer = null;
    peer.close();
    set({ kind: "failed", host: r.host, reason: "Wrong code too many times, so gitui hung up." });
  } catch (e) {
    if (r.peer !== peer) return;
    r.peer = null;
    set({ kind: "failed", host: r.host, reason: reason(e) });
  }
}

/** Try again after a failure. */
export function retry() {
  if (run && state.kind === "failed") void establish(run, "connecting");
}

/**
 * The page is shown again, e.g. iOS resumed it: replace a dead rendezvous socket, reconnect a
 * dead channel, and stop waiting between attempts.
 */
export function wake() {
  rendezvous().wake();
  const r = run;
  if (!r) return;
  r.kick?.();
  probe(r);
}

/**
 * Reconnect if the connected channel is dead. After a suspension, or once its host quit, a
 * channel can still look open while its other end is long gone (WebKit fires no close for it,
 * and ICE takes ~30 s to give up), and requests on it would wait that long. One request tells.
 */
function probe(r: Run) {
  const peer = r.peer;
  if (state.kind !== "connected" || !peer) return;
  if (!peer.isOpen()) return lost(r);
  peer
    .fetch("/api/config", {
      headers: { [CLIENT_HEADER]: "1" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    })
    .catch(() => {
      if (r.peer === peer) lost(r);
    });
}

/** The session's channel once it is connected; while it (re)connects, waits up to REQUEST_WAIT. */
function connectedPeer(): Promise<GuestPeer> {
  const ready = () => (state.kind === "connected" ? run?.peer : null);
  const waiting = () => state.kind === "connecting" || state.kind === "reconnecting";
  const peer = ready();
  if (peer) return Promise.resolve(peer);
  if (!waiting()) return Promise.reject(new NearbyError("Not connected."));
  return new Promise((resolve, reject) => {
    const settle = (peer: GuestPeer | null, error?: NearbyError) => {
      clearTimeout(timer);
      unsubscribe();
      if (peer) resolve(peer);
      else reject(error);
    };
    const timer = setTimeout(
      () => settle(null, new NearbyError("Still reconnecting.")),
      REQUEST_WAIT,
    );
    const unsubscribe = subscribeNearby(() => {
      const peer = ready();
      if (peer) settle(peer);
      else if (!waiting()) settle(null, new NearbyError("Not connected."));
    });
  });
}

/** `fetch` for API paths on the nearby host. */
export async function nearbyFetch(path: string, init: RequestInit): Promise<Response> {
  return (await connectedPeer()).fetch(path, init);
}

/**
 * Startup wiring for the hosted app: run the session the connection names, refetch everything
 * once a dropped session is back, and check on the session whenever the page is shown again.
 */
export function initNearby(queryClient: QueryClient) {
  onReconnected = () => void queryClient.invalidateQueries();
  follow(getConnection());
  subscribeConnection(() => follow(getConnection()));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) wake();
  });
}
