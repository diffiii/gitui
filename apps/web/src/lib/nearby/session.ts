import type { HostInfo } from "@gitui/shared";
import { withHeaders } from "../withHeaders.ts";
import { ChannelRequestError } from "./channelFetch.ts";
import {
  CONNECT_TIMEOUT,
  connectToHost,
  HostUnverifiedError,
  NearbyError,
  PageOutdatedError,
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
// (the channel closes, the rendezvous socket drops, so the host drops us, or a check of the
// channel gets no answer) it reconnects in the background: a new socket if needed, a new offer,
// and `resume`. lost() decides what every lost channel leads to.
//
// Requests while it (re)connects, or checks its channel, wait for it. A GET that was in flight
// when the channel died goes out again on the next one; anything else fails, since the host may
// have run it. A request whose response doesn't start within HEAD_TIMEOUT has the channel
// checked, since a channel can die without a word.

/** How long connecting, or reconnecting, keeps trying before it gives up. */
export const RETRY_WINDOW = 20_000;
/** How long the host may take to answer a code or a resume token. */
export const PROOF_TIMEOUT = 15_000;
/** How long the channel may take to answer a check that it still works. */
export const PROBE_TIMEOUT = 4000;
/** How long an open rendezvous may go without listing the host before it counts as gone. */
export const MISSING_GRACE = 3000;
/** How long a request may wait for its response to start before the channel is checked. */
export const HEAD_TIMEOUT = 8000;
/** The pause before another offer to a host that was busy while the session reconnects. */
export const REFUSED_PAUSE = 5000;

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
}

/** Members are arrow-typed: they don't use `this`, so they can be passed around on their own. */
export interface NearbySession {
  readonly host: NearbyHost;
  getState: () => NearbyState;
  subscribe: (listener: () => void) => () => void;
  /**
   * `fetch` for API paths on the host. Waits while the session (re)connects. A response the host
   * started but this page can't take (it aborted it, or it's too large) is a 502 with `{error}`.
   */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Send the code the host printed. */
  submitCode: (code: string) => Promise<void>;
  /** Try again after a failure. */
  retry: () => void;
  /**
   * The page is shown again: check that the channel still works before requests use it. An
   * attempt to (re)connect whose RETRY_WINDOW ran out meanwhile (the page was suspended, so its
   * timers are stale) starts over with a fresh one, and so does a failure that only ran out of
   * time; an attempt still within its window goes on.
   */
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
  /** When the current establish() gives up; wake() starts it over (from `state`) once it's past. */
  let deadline = 0;
  /**
   * The host turned the saved token away in this session. The token stays (only a new `session`
   * replaces it: whatever turned it away may not be the real host), but isn't offered again.
   */
  let tokenRefused = false;

  const set = (next: NearbyState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  const fail = (why: string, retryOnWake: boolean) =>
    set({ kind: "failed", reason: why, retryOnWake });

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
        resolve();
      };
      const timer = deps.setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });

  /** `promise`, or a NearbyError once `ms` pass. */
  const within = <T>(promise: Promise<T>, ms: number, message: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = deps.setTimeout(() => reject(new NearbyError(message)), ms);
      promise.then(resolve, reject).finally(() => deps.clearTimeout(timer));
    });

  const proof = (step: Promise<AuthResult>, ms = PROOF_TIMEOUT) =>
    within(step, ms, `${host.name} didn't answer in time. Try again.`);

  /**
   * Open a session with the host, trying again until RETRY_WINDOW is up, which bounds every step.
   * `connecting` blocks the app; `reconnecting` keeps it up. `notice` tells the code screen why
   * it asks again.
   */
  async function establish(mode: "connecting" | "reconnecting", notice?: "expired") {
    attempt.abort();
    const { signal } = (attempt = new AbortController());
    closePeer();
    set({ kind: mode, notice });
    const until = (deadline = deps.now() + RETRY_WINDOW);
    const left = () => until - deps.now();
    for (let failures = 0; ; failures++) {
      try {
        const listed = await locate(until, signal);
        const timeout = Math.min(CONNECT_TIMEOUT, left());
        const token = tokenRefused ? null : deps.tokens.load(host.key);
        const p = await deps.connect(listed, { signal, timeout, resume: token !== null });
        if (signal.aborted) return p.close();
        return await authenticate(p, signal, token, until, notice);
      } catch (e) {
        if (signal.aborted) return;
        closePeer();
        // Something answered for the host without proving it holds our token (don't ask it for
        // the code; the token stays, for the real host): the user decides what to do.
        if (e instanceof HostUnverifiedError) return fail(e.message, false);
        if (e instanceof HostGoneError) return set({ kind: "gone" });
        // Another offer can't help; only a reload can.
        if (e instanceof PageOutdatedError)
          return set({ kind: "failed", reason: e.message, retryOnWake: false, reload: true });
        // The host refused the offer (more offers would only add to its load or limit, which all
        // its guests share). Connecting, the user decides when to try again. Reconnecting, the app
        // is up, so a busy host gets another offer after a longer pause, until the window is up;
        // any other refusal won't change that soon.
        const refused = e instanceof RefusedError;
        if (refused && (mode === "connecting" || e.reason !== "busy"))
          return fail(e.message, false);
        const pause = refused ? REFUSED_PAUSE : Math.min(4000, 500 * 2 ** failures);
        if (left() > 0) await sleep(Math.min(pause, left()), signal);
        if (signal.aborted) return;
        if (left() <= 0) return fail(reason(e), !refused);
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
        const found = hosts.find((h) => h.key === host.key);
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

  /** Resume on a new channel with `token` (by `deadline`), or ask for the code. */
  async function authenticate(
    p: GuestPeer,
    signal: AbortSignal,
    token: string | null,
    deadline: number,
    notice?: "expired",
  ) {
    peer = p;
    p.onSession((next) => {
      deps.tokens.save(host.key, next);
      tokenRefused = false;
    });
    p.onClose(() => lost(p));
    if (token === null) return set({ kind: "code", checking: false, notice });
    const result = await proof(p.resume(token), Math.min(PROOF_TIMEOUT, deadline - deps.now()));
    // Stopped, started over or lost meanwhile: establish() returns, or tries again.
    if (signal.aborted || peer !== p)
      throw new NearbyError(`The connection to ${host.name} dropped.`);
    if (result.ok) return connected();
    tokenRefused = true;
    // A refused first `resume` leaves every attempt: ask for the code on this channel.
    if (result.attemptsLeft > 0) return set({ kind: "code", checking: false, notice: "expired" });
    void establish("connecting", "expired");
  }

  const connected = () => set({ kind: "connected", checking: false });

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
   * Check that the connected channel `p` works. After a suspension, or once its host quit, a
   * channel can still look open while its other end is long gone (WebKit fires no close for it,
   * and ICE takes ~30 s to give up). Requests wait for the check, and one request tells.
   */
  function probe(p: GuestPeer) {
    if (p !== peer || state.kind !== "connected" || state.checking) return;
    set({ kind: "connected", checking: true });
    const controller = new AbortController();
    const timer = deps.setTimeout(
      () => controller.abort(new NearbyError("No answer.")),
      PROBE_TIMEOUT,
    );
    void p
      .fetch("/api/config", withHeaders({ signal: controller.signal }))
      .then(
        () => true,
        // An `abort` is an answer from the host: the channel works.
        (e: unknown) => e instanceof ChannelRequestError,
      )
      .then((alive) => {
        deps.clearTimeout(timer);
        // Stopped or lost meanwhile: whatever did that has set the state.
        if (p !== peer) return;
        if (alive) connected();
        else lost(p);
      });
  }

  /** The channel once the session is connected and checked; waits while it gets there. */
  function ready(signal?: AbortSignal | null): Promise<GuestPeer> {
    const current = () => (state.kind === "connected" && !state.checking ? peer : null);
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

  /**
   * `path` over `p`. A response that hasn't started within HEAD_TIMEOUT has the channel checked
   * (it may have died without a word); one that has started may take as long as it takes.
   */
  async function send(p: GuestPeer, path: string, init: RequestInit) {
    const timer = deps.setTimeout(() => probe(p), HEAD_TIMEOUT);
    try {
      return await p.fetch(path, init, { onHead: () => deps.clearTimeout(timer) });
    } finally {
      deps.clearTimeout(timer);
    }
  }

  /** `path`, once connected; a GET whose channel died under it goes out again on the next. */
  async function request(path: string, init: RequestInit) {
    const p = await ready(init.signal);
    try {
      return await send(p, path, init);
    } catch (e) {
      if (p.isOpen() || init.signal?.aborted || !idempotent(init.method)) throw e;
      lost(p);
      return send(await ready(init.signal), path, init);
    }
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

    fetch: (path, init = {}) =>
      request(path, init).catch((e: unknown) => {
        // The host answered, but not with a response this page takes.
        if (!(e instanceof ChannelRequestError)) throw e;
        return Response.json({ error: e.message }, { status: 502 });
      }),

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
        return fail(reason(e), false);
      }
      if (p !== peer) return;
      if (result.ok) return connected();
      if (result.attemptsLeft > 0) {
        return set({ kind: "code", checking: false, attemptsLeft: result.attemptsLeft, notice });
      }
      closePeer();
      fail("Wrong code too many times, so gitui hung up.", false);
    },

    retry() {
      if (state.kind === "failed") void establish("connecting");
    },

    wake() {
      if (state.kind === "off") return;
      deps.rendezvous.wake();
      if (state.kind === "connecting" || state.kind === "reconnecting") {
        if (deps.now() >= deadline) void establish(state.kind, state.notice);
        return;
      }
      if (state.kind === "failed") {
        if (state.retryOnWake) void establish("connecting");
        return;
      }
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
export function nearbySession(host: NearbyHost): NearbySession {
  const client = rendezvous();
  return createSession(host, {
    rendezvous: client,
    connect: (listed, options) => connectToHost(client, listed, options),
    tokens,
    now: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
}
