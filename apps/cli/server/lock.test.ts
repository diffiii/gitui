import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { MAX_WRITES, withRepoLock, withWriteLock } from "./lock.ts";

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
