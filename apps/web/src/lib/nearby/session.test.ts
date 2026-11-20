import { CLIENT_HEADER, type HostInfo } from "@gitui/shared";
import { expect, test } from "bun:test";
import { ChannelRequestError, type FetchProgress } from "./channelFetch.ts";
import {
  HostUnverifiedError,
  NearbyError,
  PageOutdatedError,
  RefusedError,
  refusalMessage,
  type AuthResult,
  type GuestPeer,
} from "./peer.ts";
import type { RendezvousState } from "./rendezvous.ts";
import {
  createSession,
  HEAD_TIMEOUT,
  MISSING_GRACE,
  PROBE_TIMEOUT,
  PROOF_TIMEOUT,
  REFUSED_PAUSE,
  RETRY_WINDOW,
} from "./session.ts";
import { tokenStore } from "./tokens.ts";

const host = { key: "k".repeat(16), name: "MacBook" };
const listed: HostInfo = { id: "peer-1", ...host };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

interface Hung {
  path: string;
  response: Deferred<Response>;
  progress?: FetchProgress;
}

/**
 * A data channel the test answers for: resume and code checks wait until it says. Requests are
 * answered at once with their path, unless the channel is `dead`, or the path is `slow`.
 */
class FakePeer implements GuestPeer {
  readonly host = listed;
  open = true;
  /** A channel that looks open but never answers (what iOS leaves after a suspension). */
  dead = false;
  /** Paths whose requests wait for start() and finish(). */
  readonly slow = new Set<string>();
  /** Paths the host answers with `abort`. */
  readonly aborts = new Set<string>();
  closed = 0;
  readonly resumed: string[] = [];
  readonly codes: string[] = [];
  readonly requests: string[] = [];
  #proof: Deferred<AuthResult> | null = null;
  #hung: Hung[] = [];
  #onClose: ((reason: string) => void)[] = [];
  #onSession: ((token: string) => void)[] = [];

  resume(token: string) {
    this.resumed.push(token);
    return (this.#proof = deferred()).promise;
  }
  authenticate(code: string) {
    this.codes.push(code);
    return (this.#proof = deferred()).promise;
  }
  /** Answer the resume or code check in progress. */
  answer(result: AuthResult | Error) {
    const proof = this.#proof!;
    this.#proof = null;
    if (result instanceof Error) proof.reject(result);
    else proof.resolve(result);
  }
  /** Send a resume token, as the host does after `auth-ok`. */
  session(token: string) {
    this.#onSession.forEach((l) => l(token));
  }
  onSession(listener: (token: string) => void) {
    this.#onSession.push(listener);
  }
  onClose(listener: (reason: string) => void) {
    this.#onClose.push(listener);
  }
  isOpen() {
    return this.open;
  }
  fetch(path: string, init: RequestInit = {}, progress?: FetchProgress) {
    this.requests.push(path);
    if (!this.open) return Promise.reject(new NearbyError("closed"));
    if (this.aborts.has(path)) return Promise.reject(new ChannelRequestError("the app threw"));
    if (!this.dead && !this.slow.has(path)) {
      progress?.onHead?.();
      return Promise.resolve(Response.json({ path }));
    }
    const response = deferred<Response>();
    this.#hung.push({ path, response, progress });
    init.signal?.addEventListener("abort", () => response.reject(init.signal!.reason));
    return response.promise;
  }
  /** The response head of the slow request for `path` arrives. */
  start(path: string) {
    this.#hung.find((h) => h.path === path)!.progress?.onHead?.();
  }
  /** The slow request for `path` gets the rest of its response. */
  finish(path: string) {
    const hung = this.#hung.find((h) => h.path === path)!;
    this.#hung.splice(this.#hung.indexOf(hung), 1);
    hung.response.resolve(Response.json({ path }));
  }
  #end() {
    this.open = false;
    this.#proof?.reject(new NearbyError("The connection is closed."));
    this.#proof = null;
    for (const hung of this.#hung.splice(0)) hung.response.reject(new NearbyError("closed"));
  }
  /** The channel closes by itself. */
  drop() {
    this.#end();
    this.#onClose.forEach((l) => l("dropped"));
  }
  close() {
    this.closed++;
    this.#end();
  }
}

/** A session over fakes: a rendezvous that lists the host, a clock and timers the test runs. */
function harness({ token, hosts = [listed] }: { token?: string; hosts?: HostInfo[] } = {}) {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  let rendezvous: RendezvousState = { status: "open", hosts };
  const rendezvousListeners = new Set<() => void>();
  const peers: FakePeer[] = [];
  const connects: { resume: boolean }[] = [];
  /** The time each connect was given. */
  const timeouts: number[] = [];
  let refuse: Error | null = null;
  const tokens = tokenStore(() => undefined);
  if (token) tokens.save(host.key, token);
  const counts = { woken: 0 };

  const session = createSession(host, {
    rendezvous: {
      getSnapshot: () => rendezvous,
      subscribe(listener) {
        rendezvousListeners.add(listener);
        return () => void rendezvousListeners.delete(listener);
      },
      wake: () => void counts.woken++,
    },
    connect: async (_listed, { resume, timeout }) => {
      connects.push({ resume });
      timeouts.push(timeout);
      if (refuse) throw refuse;
      const peer = new FakePeer();
      peers.push(peer);
      return peer;
    },
    tokens,
    now: () => clock,
    setTimeout(run, ms) {
      timers.set(nextTimer, { at: clock + ms, run });
      return nextTimer++;
    },
    clearTimeout: (timer) => void timers.delete(timer as number),
  });

  return {
    session,
    tokens,
    peers,
    connects,
    timeouts,
    counts,
    peer: () => peers.at(-1)!,
    state: () => session.getState(),
    refuse: (error: Error | null) => void (refuse = error),
    listenersOnRendezvous: () => rendezvousListeners.size,
    setRendezvous(next: RendezvousState) {
      rendezvous = next;
      rendezvousListeners.forEach((l) => l());
    },
    /** The page is suspended for `ms`: time passes, but timers wait until it resumes. */
    suspend(ms: number) {
      clock += ms;
    },
    /** Run the timers due in the next `ms`, letting promises settle after each. */
    async advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        await flush();
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0]!;
        timers.delete(id);
        clock = timer.at;
        timer.run();
      }
      clock = until;
      await flush();
    },
  };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A harness whose session is connected, with the saved token "tok" resumed. */
async function connected() {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  return h;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

test("first pairing: asks for the code, connects with it and saves the token", async () => {
  const h = harness();
  expect(h.state()).toEqual({ kind: "connecting" });
  await flush();
  expect(h.connects).toEqual([{ resume: false }]);
  expect(h.state()).toEqual({ kind: "code", checking: false });

  void h.session.submitCode("123456");
  expect(h.state()).toEqual({ kind: "code", checking: true });
  h.peer().answer({ ok: true });
  await flush();
  h.peer().session("new-token");
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(h.tokens.load(host.key)).toBe("new-token");
  expect(h.peer().codes).toEqual(["123456"]);
});

test("a wrong code says how many attempts are left, and the right one connects", async () => {
  const h = harness();
  await flush();
  void h.session.submitCode("000000");
  h.peer().answer({ ok: false, attemptsLeft: 2 });
  await flush();
  expect(h.state()).toEqual({ kind: "code", checking: false, attemptsLeft: 2 });
  void h.session.submitCode("123456");
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(h.peers).toHaveLength(1);
});

test("the last wrong code fails the session, and the old token stays", async () => {
  const h = harness({ token: "old" });
  await flush();
  h.peer().answer({ ok: false, attemptsLeft: 3 });
  await flush();
  void h.session.submitCode("000000");
  h.peer().answer({ ok: false, attemptsLeft: 0 });
  await flush();
  expect(h.state()).toEqual({
    kind: "failed",
    reason: "Wrong code too many times, so gitui hung up.",
    retryOnWake: false,
  });
  expect(h.peer().closed).toBe(1);
  expect(h.tokens.load(host.key)).toBe("old");
});

test("a code refused because the host locked pairing says so, not that the code was wrong", async () => {
  const h = harness();
  await flush();
  void h.session.submitCode("123456");
  h.peer().answer({ ok: false, attemptsLeft: 0, locked: true });
  await flush();
  expect(h.state()).toMatchObject({
    kind: "failed",
    reason: expect.stringContaining("too many wrong codes were tried"),
    retryOnWake: false,
  });
});

test("resume: a saved token connects without the code", async () => {
  const h = harness({ token: "tok" });
  await flush();
  expect(h.connects).toEqual([{ resume: true }]);
  expect(h.peer().resumed).toEqual(["tok"]);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("a refused resume asks for the code on the same channel, keeping the token", async () => {
  const h = harness({ token: "old" });
  await flush();
  h.peer().answer({ ok: false, attemptsLeft: 3 });
  await flush();
  expect(h.state()).toEqual({ kind: "code", checking: false, notice: "expired" });
  // Whatever refused it may not be the real host: only a new token replaces it.
  expect(h.tokens.load(host.key)).toBe("old");
  void h.session.submitCode("123456");
  h.peer().answer({ ok: true });
  await flush();
  h.peer().session("new");
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(h.tokens.load(host.key)).toBe("new");
  expect(h.peers).toHaveLength(1);
});

test("an unverified host fails the session without retrying, keeping the token", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().answer(new HostUnverifiedError("Couldn't verify that this is MacBook."));
  await flush();
  expect(h.state()).toEqual({
    kind: "failed",
    reason: "Couldn't verify that this is MacBook.",
    retryOnWake: false,
  });
  await h.advance(RETRY_WINDOW);
  h.session.wake();
  await h.advance(RETRY_WINDOW);
  expect(h.connects).toHaveLength(1);
  expect(h.tokens.load(host.key)).toBe("tok");
});

test("a channel lost during the code check opens a new one and asks again", async () => {
  const h = harness();
  await flush();
  void h.session.submitCode("123456");
  h.peer().drop();
  expect(h.state()).toEqual({ kind: "connecting" });
  await flush();
  expect(h.peers).toHaveLength(2);
  expect(h.state()).toEqual({ kind: "code", checking: false });
});

test("a code check the host never answers times out into a retryable failure", async () => {
  const h = harness();
  await flush();
  void h.session.submitCode("123456");
  await h.advance(PROOF_TIMEOUT);
  expect(h.state()).toEqual({
    kind: "failed",
    reason: "MacBook didn't answer in time. Try again.",
    retryOnWake: false,
  });
  expect(h.peer().closed).toBe(1);
  h.session.retry();
  expect(h.state()).toEqual({ kind: "connecting" });
  await flush();
  expect(h.state()).toEqual({ kind: "code", checking: false });
});

test("a resume the host never answers is tried again on a new channel", async () => {
  const h = harness({ token: "tok" });
  await flush();
  await h.advance(PROOF_TIMEOUT);
  expect(h.peers[0]!.closed).toBe(1);
  await h.advance(500);
  expect(h.peers).toHaveLength(2);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("waking with a dead channel holds requests, reconnects and sends them on the new one", async () => {
  const h = await connected();
  const first = h.peer();
  first.dead = true;
  h.session.wake();
  expect(h.counts.woken).toBe(1);
  expect(first.requests).toEqual(["/api/config"]); // the check
  const held = h.session.fetch("/api/repo/status", { headers: { [CLIENT_HEADER]: "1" } });
  await flush();
  expect(first.requests).toEqual(["/api/config"]);
  expect(h.state()).toEqual({ kind: "connected", checking: true }); // the app stays up

  await h.advance(PROBE_TIMEOUT);
  expect(first.closed).toBe(1);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  expect(h.peers).toHaveLength(2);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(await (await held).json()).toEqual({ path: "/api/repo/status" });
  expect(h.peer().requests).toEqual(["/api/repo/status"]);
});

test("waking with a live channel holds requests until it answers, then lets them through", async () => {
  const h = await connected();
  const peer = h.peer();
  peer.slow.add("/api/config");
  h.session.wake();
  expect(h.state()).toEqual({ kind: "connected", checking: true });
  const held = h.session.fetch("/api/repo/log");
  await flush();
  expect(peer.requests).toEqual(["/api/config"]);
  peer.finish("/api/config");
  expect(await (await held).json()).toEqual({ path: "/api/repo/log" });
  expect(peer.requests).toEqual(["/api/config", "/api/repo/log"]);
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(h.peers).toHaveLength(1);
});

test("a GET in flight when the channel dies goes out again; a POST fails", async () => {
  const h = await connected();
  h.peer().dead = true;
  const get = h.session.fetch("/api/repo/status");
  const post = failure(h.session.fetch("/api/repo/stage", { method: "POST" }));
  await flush();
  h.peer().drop();
  expect(h.state()).toEqual({ kind: "reconnecting" });
  await flush();
  h.peer().answer({ ok: true });
  expect(await (await get).json()).toEqual({ path: "/api/repo/status" });
  expect(await post).toBeInstanceOf(NearbyError);
});

test("a cancelled request stops waiting for the session", async () => {
  const h = harness({ token: "tok" });
  const controller = new AbortController();
  const waiting = failure(h.session.fetch("/api/config", { signal: controller.signal }));
  controller.abort(new Error("cancelled"));
  expect(await waiting).toEqual(new Error("cancelled"));
});

for (const reason of ["busy", "rate-limited"] as const) {
  test(`a host that refuses the first offer (${reason}) fails the session until the user retries`, async () => {
    const h = harness();
    h.refuse(new RefusedError("MacBook", reason));
    await h.advance(RETRY_WINDOW);
    expect(h.state()).toEqual({
      kind: "failed",
      reason: refusalMessage("MacBook", reason),
      retryOnWake: false,
    });
    h.session.wake();
    await h.advance(RETRY_WINDOW);
    expect(h.connects).toHaveLength(1);
    h.refuse(null);
    h.session.retry();
    await flush();
    expect(h.state()).toEqual({ kind: "code", checking: false });
  });
}

test("a host whose key left the network is gone, even with a namesake listed", async () => {
  const namesake = { id: "peer-2", name: host.name, key: "n".repeat(16) };
  const h = harness({ token: "tok", hosts: [namesake] });
  await h.advance(MISSING_GRACE - 1);
  expect(h.state()).toEqual({ kind: "connecting" });
  await h.advance(1);
  expect(h.state()).toEqual({ kind: "gone" });
  expect(h.connects).toHaveLength(0);
  expect(h.tokens.load(host.key)).toBe("tok");
  // It comes back (its socket reconnected): try it again.
  h.setRendezvous({ status: "open", hosts: [namesake, listed] });
  await flush();
  expect(h.connects).toEqual([{ resume: true }]);
});

test("losing the rendezvous drops a connected session, which reconnects", async () => {
  const h = await connected();
  h.setRendezvous({ status: "retrying", hosts: [] });
  expect(h.peers[0]!.closed).toBe(1);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  h.setRendezvous({ status: "open", hosts: [listed] });
  await flush();
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("stop ends the session, forgets its token and fails waiting requests", async () => {
  const h = harness({ token: "tok" });
  const waiting = failure(h.session.fetch("/api/config"));
  await flush();
  h.session.stop();
  expect(h.state()).toEqual({ kind: "off" });
  expect(h.peer().closed).toBe(1);
  expect(h.tokens.load(host.key)).toBeNull();
  expect(h.listenersOnRendezvous()).toBe(0);
  expect(await waiting).toBeInstanceOf(NearbyError);
  await h.advance(RETRY_WINDOW);
  expect(h.connects).toHaveLength(1);
});

test("a resume answered as its channel drops tries again rather than staying connecting", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().answer({ ok: true });
  h.peer().drop(); // before the session hears the answer
  await flush();
  expect(h.state()).toEqual({ kind: "connecting" });
  await h.advance(500);
  expect(h.peers).toHaveLength(2);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("a channel lost during a resume is replaced by a new one", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().drop();
  await flush();
  expect(h.state()).toEqual({ kind: "connecting" });
  await h.advance(500);
  expect(h.connects).toEqual([{ resume: true }, { resume: true }]);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("a resume refused with no attempts left reopens without the token, asking for the code", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().answer({ ok: false, attemptsLeft: 0 });
  await flush();
  expect(h.peers[0]!.closed).toBe(1);
  expect(h.connects).toEqual([{ resume: true }, { resume: false }]);
  expect(h.state()).toEqual({ kind: "code", checking: false, notice: "expired" });
  expect(h.tokens.load(host.key)).toBe("tok");
});

test("stop during a resume ends it for good", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.session.stop();
  expect(h.peer().closed).toBe(1);
  await h.advance(RETRY_WINDOW);
  expect(h.state()).toEqual({ kind: "off" });
  expect(h.connects).toHaveLength(1);
});

test("stop during a check of the channel ends it for good", async () => {
  const h = await connected();
  h.peer().dead = true;
  h.session.wake();
  expect(h.state()).toEqual({ kind: "connected", checking: true });
  h.session.stop();
  await h.advance(PROBE_TIMEOUT + RETRY_WINDOW);
  expect(h.state()).toEqual({ kind: "off" });
  expect(h.connects).toHaveLength(1);
});

test("held requests fail when a reconnect gives up", async () => {
  const h = await connected();
  h.refuse(new NearbyError("MacBook didn't answer."));
  h.peer().drop();
  const held = failure(h.session.fetch("/api/repo/status"));
  await h.advance(RETRY_WINDOW);
  expect(h.state()).toEqual({
    kind: "failed",
    reason: "MacBook didn't answer.",
    retryOnWake: true,
  });
  expect(await held).toEqual(new NearbyError("Not connected."));
});

test("waking mid-reconnect after a suspension starts over with a fresh window", async () => {
  const h = await connected();
  h.setRendezvous({ status: "retrying", hosts: [] });
  expect(h.state()).toEqual({ kind: "reconnecting" });
  h.suspend(RETRY_WINDOW + 5000); // its timers are long overdue
  h.session.wake();
  await h.advance(0);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  h.setRendezvous({ status: "open", hosts: [listed] });
  await flush();
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("a connection that ran out of time tries again when the page is shown", async () => {
  const h = harness({ token: "tok" });
  h.refuse(new NearbyError("MacBook didn't answer."));
  await h.advance(RETRY_WINDOW);
  expect(h.state()).toEqual({
    kind: "failed",
    reason: "MacBook didn't answer.",
    retryOnWake: true,
  });
  h.refuse(null);
  h.session.wake();
  expect(h.state()).toEqual({ kind: "connecting" });
  await flush();
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("a busy host while reconnecting gets another offer after a longer pause, keeping the app up", async () => {
  const h = await connected();
  h.refuse(new RefusedError("MacBook", "busy"));
  h.peer().drop();
  await flush();
  expect(h.state()).toEqual({ kind: "reconnecting" });
  expect(h.connects).toHaveLength(2);
  await h.advance(REFUSED_PAUSE - 1);
  expect(h.connects).toHaveLength(2);
  h.refuse(null);
  await h.advance(1);
  expect(h.connects).toHaveLength(3);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("refusals until the reconnect window is up fail it, for the user to retry", async () => {
  const h = await connected();
  h.refuse(new RefusedError("MacBook", "busy"));
  h.peer().drop();
  await h.advance(RETRY_WINDOW - 1);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  await h.advance(1);
  expect(h.state()).toEqual({
    kind: "failed",
    reason: refusalMessage("MacBook", "busy"),
    retryOnWake: false,
  });
  const connects = h.connects.length;
  h.session.wake();
  await h.advance(RETRY_WINDOW);
  expect(h.connects).toHaveLength(connects);
});

test("the retry window bounds the last attempt", async () => {
  const h = harness({ token: "tok" });
  h.refuse(new NearbyError("MacBook didn't answer."));
  await h.advance(RETRY_WINDOW - 1);
  expect(h.state()).toEqual({ kind: "connecting" });
  // Attempts at 0, 0.5, 1.5, 3.5, 7.5, 11.5, 15.5 and 19.5 s: the last one gets what is left.
  expect(h.timeouts).toEqual([20_000, 19_500, 18_500, 16_500, 12_500, 8500, 4500, 500]);
  await h.advance(1);
  expect(h.state()).toMatchObject({ kind: "failed", retryOnWake: true });
});

test("a request whose response doesn't start in time has the channel checked", async () => {
  const h = await connected();
  const first = h.peer();
  first.dead = true;
  const get = h.session.fetch("/api/repo/status");
  await h.advance(HEAD_TIMEOUT - 1);
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  await h.advance(1);
  expect(h.state()).toEqual({ kind: "connected", checking: true });
  expect(first.requests).toEqual(["/api/repo/status", "/api/config"]);
  await h.advance(PROBE_TIMEOUT);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  h.peer().answer({ ok: true });
  expect(await (await get).json()).toEqual({ path: "/api/repo/status" });
});

test("a slow request on a live channel isn't cut off, whether its response started or not", async () => {
  const h = await connected();
  const peer = h.peer();
  peer.slow.add("/api/repo/remote/push").add("/api/repo/remote/fetch");
  const push = h.session.fetch("/api/repo/remote/push", { method: "POST" });
  const fetch = h.session.fetch("/api/repo/remote/fetch", { method: "POST" });
  await flush();
  peer.start("/api/repo/remote/push");
  await h.advance(HEAD_TIMEOUT);
  // Only the one without a response yet has the channel checked, which answers.
  expect(peer.requests.filter((p) => p === "/api/config")).toHaveLength(1);
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  await h.advance(HEAD_TIMEOUT * 4);
  expect(peer.requests.filter((p) => p === "/api/config")).toHaveLength(1); // and no more
  peer.finish("/api/repo/remote/push");
  peer.finish("/api/repo/remote/fetch");
  expect((await push).status).toBe(200);
  expect((await fetch).status).toBe(200);
  expect(h.peers).toHaveLength(1);
});

test("a host that leaves the list has the channel checked, and is gone if it doesn't answer", async () => {
  const h = await connected();
  h.setRendezvous({ status: "open", hosts: [] });
  expect(h.state()).toEqual({ kind: "connected", checking: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false }); // it answered
  h.setRendezvous({ status: "open", hosts: [listed] });
  h.peer().dead = true;
  h.setRendezvous({ status: "open", hosts: [] });
  await h.advance(PROBE_TIMEOUT);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  await h.advance(MISSING_GRACE);
  expect(h.state()).toEqual({ kind: "gone" });
});

test("a response the host aborts comes back as a 502 with the error", async () => {
  const h = await connected();
  h.peer().aborts.add("/api/repo/status");
  const res = await h.session.fetch("/api/repo/status");
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "the app threw" });
});

for (const reason of ["rate-limited", "pairing-locked", "bad-offer", "unknown"] as const) {
  test(`a refusal (${reason}) while reconnecting fails at once, without another offer`, async () => {
    const h = await connected();
    h.refuse(new RefusedError("MacBook", reason));
    h.peer().drop();
    await flush();
    expect(h.state()).toEqual({
      kind: "failed",
      reason: refusalMessage("MacBook", reason),
      retryOnWake: false,
    });
    h.session.wake();
    await h.advance(RETRY_WINDOW);
    expect(h.connects).toHaveLength(2);
  });
}

test("a page that can't load CPace asks for a reload, and never tries again by itself", async () => {
  const h = harness({ token: "tok" });
  h.refuse(new PageOutdatedError());
  await flush();
  expect(h.state()).toEqual({
    kind: "failed",
    reason: "This page is out of date. Reload it.",
    retryOnWake: false,
    reload: true,
  });
  await h.advance(RETRY_WINDOW);
  h.session.wake();
  await h.advance(RETRY_WINDOW);
  expect(h.connects).toHaveLength(1);
});

test("waking within the retry window lets the attempt in progress go on", async () => {
  const h = harness({ token: "tok" });
  await flush();
  expect(h.connects).toHaveLength(1);
  // Switching away and back, or a bfcache restore's visibilitychange and pageshow.
  h.session.wake();
  h.session.wake();
  await flush();
  expect(h.connects).toHaveLength(1);
  expect(h.peer().closed).toBe(0);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
});

test("waking twice after the retry window ran out starts over once", async () => {
  const h = harness({ token: "tok" });
  h.refuse(new NearbyError("MacBook didn't answer."));
  await flush();
  expect(h.connects).toHaveLength(1);
  h.suspend(RETRY_WINDOW); // the pause before the next attempt is overdue
  h.refuse(null);
  h.session.wake();
  h.session.wake();
  await flush();
  expect(h.connects).toHaveLength(2);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(h.connects).toHaveLength(2);
});

test("restarting after a refused resume keeps asking with its notice", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().answer({ ok: false, attemptsLeft: 0 });
  h.refuse(new NearbyError("MacBook didn't answer."));
  await flush();
  expect(h.state()).toEqual({ kind: "connecting", notice: "expired" });
  h.suspend(RETRY_WINDOW);
  h.refuse(null);
  h.session.wake();
  await flush();
  expect(h.state()).toEqual({ kind: "code", checking: false, notice: "expired" });
});

test("a check of the channel that the host answers with an abort counts as an answer", async () => {
  const h = await connected();
  h.peer().aborts.add("/api/config");
  h.session.wake();
  await flush();
  expect(h.state()).toEqual({ kind: "connected", checking: false });
  expect(h.peers).toHaveLength(1);
  expect(h.peer().closed).toBe(0);
});
