import { CLIENT_HEADER, type HostInfo } from "@gitui/shared";
import { expect, test } from "bun:test";
import {
  HostUnverifiedError,
  NearbyError,
  RefusedError,
  type AuthResult,
  type GuestPeer,
} from "./peer.ts";
import type { RendezvousState } from "./rendezvous.ts";
import {
  createSession,
  MISSING_GRACE,
  PROBE_TIMEOUT,
  PROOF_TIMEOUT,
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

/** A data channel the test answers for: resume and code checks wait until it says. */
class FakePeer implements GuestPeer {
  readonly host = listed;
  open = true;
  /** A channel that looks open but never answers (what iOS leaves after a suspension). */
  dead = false;
  closed = 0;
  readonly resumed: string[] = [];
  readonly codes: string[] = [];
  readonly requests: string[] = [];
  #proof: Deferred<AuthResult> | null = null;
  #hung: Deferred<Response>[] = [];
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
  fetch(path: string, init: RequestInit = {}) {
    this.requests.push(path);
    if (!this.open) return Promise.reject(new NearbyError("closed"));
    if (!this.dead) return Promise.resolve(Response.json({ path }));
    const hung = deferred<Response>();
    this.#hung.push(hung);
    init.signal?.addEventListener("abort", () => hung.reject(init.signal!.reason));
    return hung.promise;
  }
  #end() {
    this.open = false;
    this.#proof?.reject(new NearbyError("The connection is closed."));
    this.#proof = null;
    for (const hung of this.#hung.splice(0)) hung.reject(new NearbyError("closed"));
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
  let refuse: Error | null = null;
  const tokens = tokenStore(() => undefined);
  if (token) tokens.save(host.key, token);
  const counts = { reconnected: 0, woken: 0 };

  const session = createSession(host, {
    rendezvous: {
      getSnapshot: () => rendezvous,
      subscribe(listener) {
        rendezvousListeners.add(listener);
        return () => void rendezvousListeners.delete(listener);
      },
      wake: () => void counts.woken++,
    },
    connect: async (_listed, { resume }) => {
      connects.push({ resume });
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
    onReconnected: () => void counts.reconnected++,
  });

  return {
    session,
    tokens,
    peers,
    connects,
    counts,
    peer: () => peers.at(-1)!,
    state: () => session.getState(),
    refuse: (error: Error | null) => void (refuse = error),
    listenersOnRendezvous: () => rendezvousListeners.size,
    setRendezvous(next: RendezvousState) {
      rendezvous = next;
      rendezvousListeners.forEach((l) => l());
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
  expect(h.state()).toEqual({ kind: "connected" });
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
  expect(h.state()).toEqual({ kind: "connected" });
  expect(h.tokens.load(host.key)).toBe("new-token");
  expect(h.peer().codes).toEqual(["123456"]);
  expect(h.counts.reconnected).toBe(0);
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
  expect(h.state()).toEqual({ kind: "connected" });
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
  });
  expect(h.peer().closed).toBe(1);
  expect(h.tokens.load(host.key)).toBe("old");
});

test("resume: a saved token connects without the code", async () => {
  const h = harness({ token: "tok" });
  await flush();
  expect(h.connects).toEqual([{ resume: true }]);
  expect(h.peer().resumed).toEqual(["tok"]);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected" });
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
  expect(h.state()).toEqual({ kind: "connected" });
  expect(h.tokens.load(host.key)).toBe("new");
  expect(h.peers).toHaveLength(1);
});

test("an unverified host fails the session without retrying, keeping the token", async () => {
  const h = harness({ token: "tok" });
  await flush();
  h.peer().answer(new HostUnverifiedError("Couldn't verify that this is MacBook."));
  await flush();
  expect(h.state()).toEqual({ kind: "failed", reason: "Couldn't verify that this is MacBook." });
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
  expect(h.state()).toEqual({ kind: "connected" });
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
  expect(h.state()).toEqual({ kind: "connected" }); // no flash while it checks

  await h.advance(PROBE_TIMEOUT);
  expect(first.closed).toBe(1);
  expect(h.state()).toEqual({ kind: "reconnecting" });
  expect(h.peers).toHaveLength(2);
  h.peer().answer({ ok: true });
  await flush();
  expect(h.state()).toEqual({ kind: "connected" });
  expect(await (await held).json()).toEqual({ path: "/api/repo/status" });
  expect(h.peer().requests).toEqual(["/api/repo/status"]);
  expect(h.counts.reconnected).toBe(1);
});

test("waking with a live channel lets held requests through once it answers", async () => {
  const h = await connected();
  h.session.wake();
  const held = h.session.fetch("/api/repo/log");
  expect(await (await held).json()).toEqual({ path: "/api/repo/log" });
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

for (const reason of ["busy", "rate-limited"]) {
  test(`a host that refuses the offer (${reason}) fails the session until the user retries`, async () => {
    const h = harness();
    h.refuse(new RefusedError(`MacBook is ${reason}.`));
    await h.advance(RETRY_WINDOW);
    expect(h.state()).toEqual({ kind: "failed", reason: `MacBook is ${reason}.` });
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
  expect(h.state()).toEqual({ kind: "connected" });
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
