import { expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { MAX_WRITES, lockedWrite, withRepoLock, withWriteLock } from "./lock.ts";

/** Lets every fiber that can run do so. */
const settle = Effect.promise(() => Bun.sleep(20));

test("at most MAX_WRITES writes run at once, over all repos", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let running = 0;
      const gate = yield* Deferred.make<void>();
      const write = (repo: string) =>
        withWriteLock(
          repo,
          Effect.ensuring(
            Effect.andThen(
              Effect.sync(() => running++),
              Deferred.await(gate),
            ),
            Effect.sync(() => running--),
          ),
        );
      const fibers = yield* Effect.forEach(
        Array.from({ length: MAX_WRITES + 3 }, (_, i) => `/repo-${i}`),
        (repo) => Effect.forkChild(write(repo)),
      );
      yield* settle;
      expect(running).toBe(MAX_WRITES);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.joinAll(fibers);
      expect(running).toBe(0);
    }),
  );
});

test("writes waiting for a busy repo hold no permit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* Effect.forkChild(withRepoLock("/busy", Effect.never));
      yield* settle;
      const queued = yield* Effect.forEach(Array.from({ length: MAX_WRITES * 2 }), () =>
        Effect.forkChild(withWriteLock("/busy", Effect.void)),
      );
      yield* settle;
      // Another repo's write still gets a permit at once.
      expect(yield* Effect.timeoutOption(withWriteLock("/other", Effect.succeed(1)), 500)).toEqual(
        expect.objectContaining({ value: 1 }),
      );
      yield* Fiber.interrupt(held);
      yield* Fiber.joinAll(queued);
    }),
  );
});

/** Lets every fiber that is ready run until it blocks, without waiting on a clock. */
const yieldAll = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

/**
 * MAX_WRITES writes on repos of their own, once they all run at once (it never gets there if a
 * permit is gone), with what lets them end.
 */
const busyWrites = (prefix: string) =>
  Effect.gen(function* () {
    let running = 0;
    const full = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const fibers = yield* Effect.forEach(
      Array.from({ length: MAX_WRITES }, (_, i) => `${prefix}${i}`),
      (repo) =>
        Effect.forkChild(
          withWriteLock(
            repo,
            Effect.andThen(
              Effect.suspend(() =>
                ++running === MAX_WRITES ? Deferred.succeed(full, undefined) : Effect.void,
              ),
              Deferred.await(gate),
            ),
          ),
        ),
    );
    yield* Deferred.await(full);
    return Effect.andThen(Deferred.succeed(gate, undefined), Fiber.joinAll(fibers));
  });

test("lockedWrite: a write whose caller leaves while it waits for its repo never runs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* Scope.make();
      const holding = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        withRepoLock(
          "/a",
          Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(gate)),
        ),
      );
      yield* Deferred.await(holding);
      let ran = false;
      const caller = yield* Effect.forkChild(
        lockedWrite(
          "/a",
          Effect.sync(() => {
            ran = true;
          }),
          server,
        ),
      );
      yield* yieldAll;
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(holder);
      // First come, first served: the dropped write has had its turn before this one.
      expect(yield* withWriteLock("/a", Effect.succeed(1))).toBe(1);
      expect(ran).toBe(false);
      yield* Scope.close(server, Exit.void);
    }),
  );
});

test("lockedWrite: a write whose caller leaves while it waits for a permit never runs", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* Scope.make();
      const release = yield* busyWrites("/p-");
      let ran = false;
      const caller = yield* Effect.forkChild(
        lockedWrite(
          "/b",
          Effect.sync(() => {
            ran = true;
          }),
          server,
        ),
      );
      yield* yieldAll;
      yield* Fiber.interrupt(caller);
      yield* release;
      expect(yield* withWriteLock("/b", Effect.succeed(1))).toBe(1);
      expect(ran).toBe(false);
      yield* Scope.close(server, Exit.void);
    }),
  );
});

test("lockedWrite: a started write outlives its caller and holds the lock to its end", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const events: string[] = [];
      const work = Effect.andThen(
        Deferred.succeed(started, undefined),
        Deferred.await(finish),
      ).pipe(Effect.andThen(Effect.sync(() => events.push("write"))));
      const caller = yield* Effect.forkChild(lockedWrite("/c", work, server));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);
      const next = yield* Effect.forkChild(
        withRepoLock(
          "/c",
          Effect.sync(() => events.push("next")),
        ),
      );
      yield* yieldAll;
      expect(events).toEqual([]);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(next);
      expect(events).toEqual(["write", "next"]);
      yield* Scope.close(server, Exit.void);
    }),
  );
});

test("lockedWrite: closing the server's scope stops a running write and frees its permit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const work = Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
      const caller = yield* Effect.forkChild(lockedWrite("/d", work, server));
      yield* Deferred.await(started);
      yield* Scope.close(server, Exit.void);
      expect(interrupted).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true);
      expect(yield* withRepoLock("/d", Effect.succeed(1))).toBe(1);
      // Every permit is free again.
      yield* Effect.flatten(busyWrites("/free-"));
    }),
  );
});
