import { CLIENT_HEADER, type HostInfo } from "@gitui/shared";
import {
  CONNECT_TIMEOUT,
  connectToHost,
  HostUnverifiedError,
  NearbyError,
  RefusedError,
  type AuthResult,
  type GuestPeer,
} from "./peer.ts";
import { rendezvous, type Rendezvous } from "./rendezvous.ts";
import type { NearbyHost, NearbyState } from "./state.ts";
import { tokens, type TokenStore } from "./tokens.ts";

// A session with one nearby host, from when the user picks it (or a reload finds it saved) until
// stop(). It is an external store of NearbyState, and the transport the API client sends that
// host's requests through (fetch). It finds the host on the rendezvous by key, opens a data
// channel, and resumes with the saved token or asks for the code. When a connected session drops
// (the channel closes, the rendezvous socket drops, so the host drops us, or a check after the
// page was shown again gets no answer) it reconnects in the background: a new socket if needed, a
// new offer, and `resume`. lost() decides what every lost channel leads to.
//
// Requests while it (re)connects, or checks its channel, wait for it. A GET that was in flight
// when the channel died goes out again on the next one; anything else fails, since the host may
// have run it. Once a dropped session is back, `onReconnected` refetches what failed meanwhile.

/** How long connecting, or reconnecting, keeps trying before it gives up. */
export const RETRY_WINDOW = 20_000;
/** How long the host may take to answer a code or a resume token. */
export const PROOF_TIMEOUT = 15_000;
/** How long the channel may take to answer the check made when the page is shown again. */
export const PROBE_TIMEOUT = 4000;
/** How long an open rendezvous may go without listing the host before it counts as gone. */
export const MISSING_GRACE = 3000;

/** The rendezvous doesn't list the host's key. */
class HostGoneError extends NearbyError {}

export interface SessionDeps {
  rendezvous: Pick<Rendezvous, "getSnapshot" | "subscribe" | "wake">;
  /** Open a data channel to `host` (connectToHost). */
  connect(
    host: HostInfo,
    options: { signal: AbortSignal; timeout: number; resume: boolean },
  ): Promise<GuestPeer>;
  tokens: TokenStore;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** The session is back after a drop: refetch what failed meanwhile. */
  onReconnected(): void;
}

/** Members are arrow-typed: they don't use `this`, so they can be passed around on their own. */
export interface NearbySession {
  readonly host: NearbyHost;
  getState: () => NearbyState;
  subscribe: (listener: () => void) => () => void;
  /** `fetch` for API paths on the host. Waits while the session (re)connects. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Send the code the host printed. */
  submitCode: (code: string) => Promise<void>;
  /** Try again after a failure. */
  retry: () => void;
  /** The page is shown again: check that the channel still works before requests use it. */
  wake: () => void;
  /** End the session and forget its resume token: the user disconnected, or chose another host. */
  stop: () => void;
}

const reason = (e: unknown) =>
  e instanceof NearbyError ? e.message : `Something went wrong: ${String(e)}`;

const idempotent = (method = "GET") => method === "GET" || method === "HEAD";

export function createSession(host: NearbyHost, deps: SessionDeps): NearbySession {
  let state: NearbyState = { kind: "connecting" };
  const listeners = new Set<() => void>();
  /** The data channel, from the moment it opens. */
  let peer: GuestPeer | null = null;
  /** Aborts the step in progress: finding the host, connecting, a pause between attempts. */
  let attempt = new AbortController();
  /** Ends the pause between attempts early. */
  let kick: (() => void) | null = null;
  /** Whether it was connected before, so coming back refetches what failed meanwhile. */
  let wasConnected = false;
  /** Checking the channel after the page was shown again; requests wait for it. */
  let probing = false;
  /**
   * The host turned the saved token away in this session. The token stays (only a new `session`
   * replaces it: whatever turned it away may not be the real host), but isn't offered again.
   */
  let tokenRefused = false;

  const notify = () => listeners.forEach((l) => l());
  const set = (next: NearbyState) => {
    state = next;
    notify();
  };

  const closePeer = () => {
    const p = peer;
    peer = null;
    p?.close();
  };

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        deps.clearTimeout(timer);
        signal.removeEventListener("abort", done);
        kick = null;
        resolve();
      };
      const timer = deps.setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      kick = done;
    });

  /** `promise`, or a NearbyError once `ms` pass. */
  const within = <T>(promise: Promise<T>, ms: number, message: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = deps.setTimeout(() => reject(new NearbyError(message)), ms);
      promise.then(resolve, reject).finally(() => deps.clearTimeout(timer));
    });

  const proof = (step: Promise<AuthResult>) =>
    within(step, PROOF_TIMEOUT, `${host.name} didn't answer in time. Try again.`);

  /**
   * Open a session with the host, trying again until RETRY_WINDOW is up. `connecting` blocks the
   * app; `reconnecting` keeps it up. `notice` tells the code screen why it asks again.
   */
  async function establish(mode: "connecting" | "reconnecting", notice?: "expired") {
    attempt.abort();
    const { signal } = (attempt = new AbortController());
    closePeer();
    set({ kind: mode });
    const deadline = deps.now() + RETRY_WINDOW;
    for (let failures = 0; ; failures++) {
      try {
        const listed = await locate(deadline, signal);
        const timeout = Math.max(2000, Math.min(CONNECT_TIMEOUT, deadline - deps.now()));
        const token = tokenRefused ? null : deps.tokens.load(host.key);
        const p = await deps.connect(listed, { signal, timeout, resume: token !== null });
        if (signal.aborted) return p.close();
        return await authenticate(p, signal, token, notice);
      } catch (e) {
        if (signal.aborted) return;
        closePeer();
        // Something answered for the host without proving it holds our token (don't ask it for
        // the code; the token stays, for the real host), or the host refused the offer (more
        // offers would only add to its load or limit): the user decides when to try again.
        if (e instanceof HostUnverifiedError || e instanceof RefusedError) {
          return set({ kind: "failed", reason: e.message });
        }
        if (e instanceof HostGoneError) return set({ kind: "gone" });
        if (deps.now() >= deadline) return set({ kind: "failed", reason: reason(e) });
        await sleep(Math.min(4000, 500 * 2 ** failures), signal);
        if (signal.aborted) return;
      }
    }
  }

  /**
   * The host's entry once the rendezvous lists its key. Rejects with a HostGoneError once an open
   * rendezvous hasn't listed it for MISSING_GRACE (a restarted CLI has a new key, and another
   * computer by the same name is no proof of anything), or a NearbyError at `deadline`.
   */
  function locate(deadline: number, signal: AbortSignal): Promise<HostInfo> {
    const client = deps.rendezvous;
    return new Promise((resolve, reject) => {
      let grace: unknown = null;
      const finish = (settle: () => void) => {
        deps.clearTimeout(timer);
        deps.clearTimeout(grace);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(signal.reason));
      const check = () => {
        const { status, hosts } = client.getSnapshot();
        if (status !== "open") {
          deps.clearTimeout(grace);
          grace = null;
          return;
        }
        const found = hosts.findLast((h) => h.key === host.key);
        if (found) return finish(() => resolve(found));
        grace ??= deps.setTimeout(
          () =>
            finish(() => reject(new HostGoneError(`${host.name} isn't on this network any more.`))),
          MISSING_GRACE,
        );
      };
      const timer = deps.setTimeout(
        () =>
          finish(() =>
            reject(
              new NearbyError(
                client.getSnapshot().status === "open"
                  ? `Can't find ${host.name} on this network. Is gitui still running there with --nearby?`
                  : "Can't reach the rendezvous server. Check your connection and try again.",
              ),
            ),
          ),
        Math.max(0, deadline - deps.now()),
      );
      const unsubscribe = client.subscribe(check);
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  /** Resume on a new channel with `token`, or ask for the code. */
  async function authenticate(
    p: GuestPeer,
    signal: AbortSignal,
    token: string | null,
    notice?: "expired",
  ) {
    peer = p;
    p.onSession((next) => {
      deps.tokens.save(host.key, next);
      tokenRefused = false;
    });
    p.onClose(() => lost(p));
    if (token === null) return set({ kind: "code", checking: false, notice });
    const result = await proof(p.resume(token));
    if (signal.aborted || peer !== p) return;
    if (result.ok) return connected();
    tokenRefused = true;
    // A refused first `resume` leaves every attempt: ask for the code on this channel.
    if (result.attemptsLeft > 0) return set({ kind: "code", checking: false, notice: "expired" });
    void establish("connecting", "expired");
  }

  function connected() {
    set({ kind: "connected" });
    if (wasConnected) deps.onReconnected();
    wasConnected = true;
  }

  /** The channel `p` is gone (or doesn't answer): what happens next, whatever the state. */
  function lost(p: GuestPeer) {
    if (p !== peer) return; // one already dealt with
    closePeer();
    switch (state.kind) {
      case "connected":
        return void establish("reconnecting");
      // The code (and any check of it) went with the channel; ask again on a new one.
      case "code":
        return void establish("connecting", state.notice);
      // The attempt that opened the channel is waiting on it, fails, and tries again.
      case "connecting":
      case "reconnecting":
      case "failed":
      case "gone":
      case "off":
        return;
    }
  }

  /**
   * Check that the connected channel works. After a suspension, or once its host quit, a channel
   * can still look open while its other end is long gone (WebKit fires no close for it, and ICE
   * takes ~30 s to give up). Requests wait for the check, and one request tells.
   */
  function probe(p: GuestPeer) {
    if (probing || state.kind !== "connected") return;
    probing = true;
    notify();
    const controller = new AbortController();
    const timer = deps.setTimeout(
      () => controller.abort(new NearbyError("No answer.")),
      PROBE_TIMEOUT,
    );
    void p
      .fetch("/api/config", { headers: { [CLIENT_HEADER]: "1" }, signal: controller.signal })
      .then(
        () => true,
        () => false,
      )
      .then((alive) => {
        deps.clearTimeout(timer);
        probing = false;
        if (!alive) lost(p);
        notify();
      });
  }

  /** The channel once the session is connected and checked; waits while it gets there. */
  function ready(signal?: AbortSignal | null): Promise<GuestPeer> {
    const current = () => (state.kind === "connected" && !probing ? peer : null);
    const waiting = () =>
      state.kind === "connecting" || state.kind === "reconnecting" || state.kind === "connected";
    const now = current();
    if (now) return Promise.resolve(now);
    if (!waiting()) return Promise.reject(new NearbyError("Not connected."));
    return new Promise((resolve, reject) => {
      const settle = (p: GuestPeer | null, error?: unknown) => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        if (p) resolve(p);
        else reject(error);
      };
      const onAbort = () => settle(null, signal!.reason);
      const unsubscribe = subscribe(() => {
        const p = current();
        if (p) settle(p);
        else if (!waiting()) settle(null, new NearbyError("Not connected."));
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  // The session holds the rendezvous socket for as long as it lasts: the host ends a session as
  // soon as its guest's socket is gone, so when ours drops, so does the channel. A host that
  // leaves the list may have left a dead channel behind, and one that comes back is worth trying.
  let wasOpen = deps.rendezvous.getSnapshot().status === "open";
  let wasListed = true;
  const stopRendezvous = deps.rendezvous.subscribe(() => {
    const { status, hosts } = deps.rendezvous.getSnapshot();
    const open = status === "open";
    if (wasOpen && !open && peer) lost(peer);
    wasOpen = open;
    const listed = !open || hosts.some((h) => h.key === host.key);
    if (wasListed && !listed && peer) probe(peer);
    if (open && listed && state.kind === "gone") void establish("connecting");
    wasListed = listed;
  });

  void establish("connecting");

  return {
    host,
    getState: () => state,
    subscribe,

    async fetch(path, init = {}) {
      const p = await ready(init.signal);
      try {
        return await p.fetch(path, init);
      } catch (e) {
        // The channel died under it: a GET goes out again once the session is back.
        if (p.isOpen() || init.signal?.aborted || !idempotent(init.method)) throw e;
        lost(p);
        return (await ready(init.signal)).fetch(path, init);
      }
    },

    async submitCode(code) {
      const p = peer;
      if (!p || state.kind !== "code" || state.checking) return;
      const { notice } = state;
      set({ ...state, checking: true });
      let result: AuthResult;
      try {
        result = await proof(p.authenticate(code));
      } catch (e) {
        if (p !== peer) return;
        if (!p.isOpen()) return lost(p);
        closePeer();
        return set({ kind: "failed", reason: reason(e) });
      }
      if (p !== peer) return;
      if (result.ok) return connected();
      if (result.attemptsLeft > 0) {
        return set({ kind: "code", checking: false, attemptsLeft: result.attemptsLeft, notice });
      }
      closePeer();
      set({ kind: "failed", reason: "Wrong code too many times, so gitui hung up." });
    },

    retry() {
      if (state.kind === "failed") void establish("connecting");
    },

    wake() {
      if (state.kind === "off") return;
      deps.rendezvous.wake();
      kick?.();
      const p = peer;
      if (!p) return;
      if (!p.isOpen()) return lost(p);
      probe(p);
    },

    stop() {
      if (state.kind === "off") return;
      attempt.abort(new NearbyError("Disconnected."));
      closePeer();
      stopRendezvous();
      deps.tokens.forget(host.key);
      set({ kind: "off" });
      listeners.clear();
    },
  };
}

/** A session over the page's rendezvous, WebRTC, saved tokens and timers. */
export function nearbySession(host: NearbyHost, onReconnected: () => void): NearbySession {
  const client = rendezvous();
  return createSession(host, {
    rendezvous: client,
    connect: (listed, options) => connectToHost(client, listed, options),
    tokens,
    now: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onReconnected,
  });
}
