import { expect, test } from "bun:test";
import { NearbyError, PageOutdatedError } from "./errors.ts";
import { lazySession, loadedNearby, loadNearby } from "./lazy.ts";
import type { NearbySession } from "./session.ts";
import type { NearbyHost, NearbyState } from "./state.ts";

const host = { key: "k".repeat(16), name: "MacBook" };

/** A session whose state the test sets, and that records what it is asked. */
function fakeSession(h: NearbyHost) {
  let state: NearbyState = { kind: "connecting" };
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const session = {
    host: h,
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    fetch: async (path: string) => {
      calls.push(`fetch ${path}`);
      return new Response("ok");
    },
    submitCode: async (code: string) => void calls.push(`code ${code}`),
    retry: () => void calls.push("retry"),
    wake: () => void calls.push("wake"),
    stop: () => {
      calls.push("stop");
      session.set({ kind: "off" });
    },
    set(next: NearbyState) {
      state = next;
      listeners.forEach((l) => l());
    },
    calls,
  } satisfies NearbySession & Record<string, unknown>;
  return session;
}

/** A load that the test resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Open = (host: NearbyHost) => NearbySession;

test("a lazy session connects while its code loads, then is the session it opens", async () => {
  const load = deferred<Open | null>();
  const opened: ReturnType<typeof fakeSession>[] = [];
  const session = lazySession(host, () => load.promise);
  let notified = 0;
  session.subscribe(() => notified++);
  expect(session.getState()).toEqual({ kind: "connecting" });
  session.wake(); // nothing to wake yet
  const response = session.fetch("/api/config");

  load.resolve((h) => {
    const s = fakeSession(h);
    opened.push(s);
    return s;
  });
  expect(await (await response).text()).toBe("ok");
  expect(opened.map((s) => s.host)).toEqual([host]);
  const inner = opened[0]!;
  expect(notified).toBe(1);

  inner.set({ kind: "code", checking: false });
  expect(session.getState()).toEqual({ kind: "code", checking: false });
  expect(notified).toBe(2);
  await session.submitCode("123456");
  session.retry();
  session.wake();
  session.stop();
  session.stop();
  expect(inner.calls).toEqual(["fetch /api/config", "code 123456", "retry", "wake", "stop"]);
  expect(session.getState()).toEqual({ kind: "off" });
});

test("a lazy session whose code can't load fails, for a reload", async () => {
  const session = lazySession(host, async () => null);
  let notified = 0;
  session.subscribe(() => notified++);
  expect(await session.fetch("/api/config").catch((e: unknown) => e)).toBeInstanceOf(
    PageOutdatedError,
  );
  expect(session.getState()).toEqual({
    kind: "failed",
    reason: new PageOutdatedError().message,
    retryOnWake: false,
    reload: true,
  });
  expect(notified).toBe(1);
});

test("a lazy session stopped before its code loads opens none", async () => {
  const load = deferred<Open | null>();
  let opens = 0;
  const session = lazySession(host, () => load.promise);
  const states: string[] = [];
  session.subscribe(() => states.push(session.getState().kind));
  const response = session.fetch("/api/config").catch((e: unknown) => e);
  session.stop();
  load.resolve((h) => (opens++, fakeSession(h)));
  expect(await response).toEqual(new NearbyError("Disconnected."));
  expect(opens).toBe(0);
  expect(states).toEqual(["off"]);
});

test("loadNearby loads the nearby code once", async () => {
  expect(loadedNearby()).toBeNull();
  const first = loadNearby();
  expect(loadNearby()).toBe(first);
  const nearby = await first;
  expect(typeof nearby?.nearbySession).toBe("function");
  expect(typeof nearby?.rendezvous).toBe("function");
  expect(loadedNearby()).toBe(nearby);
});
