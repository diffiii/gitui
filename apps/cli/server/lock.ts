import { Effect, Fiber, type Scope, Semaphore } from "effect";

/** A one-permit semaphore per key, with how many callers hold or wait for it. */
const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/**
 * `effect`, run after every earlier one for the same `key` has finished, however it ended (a
 * per-key mutex). A key's semaphore is dropped once nobody holds or waits for it.
 */
export const withRepoLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let lock = locks.get(key);
    if (!lock) {
      lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(key, lock);
    }
    const entry = lock;
    entry.users++;
    return entry.semaphore
      .withPermits(1)(effect)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
        ),
      );
  });

/** How many locked git writes may run at once, over every repo and every app in the process. */
export const MAX_WRITES = 8;

const writes = Semaphore.makeUnsafe(MAX_WRITES);

/**
 * `effect` under `repo`'s lock (withRepoLock), and then one of MAX_WRITES permits that all repos
 * share, so writes queued on many repos can't start a git each at once. The lock comes first: a
 * write holds a permit only while it runs, never while it waits for its repo, so writes queued
 * on one busy repo leave the permits to other repos, and a permit holder waits for nothing else.
 */
export const withWriteLock = <A, E, R>(
  repo: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withRepoLock(repo, writes.withPermits(1)(effect));

/**
 * A locked write route's `work`, run one at a time per repo under its write lock
 * (withWriteLock), so concurrent git commands don't collide on .git/index.lock. It runs in a
 * fiber of the server's `scope`: once it holds the lock and a permit, its client going away
 * doesn't stop it, as git may be halfway through a write; shutting the server down, or git's
 * timeout, still does. A client that goes away before then drops it: the write still takes its
 * turn in the queue, but skips itself, so until then it holds its place (and, once it has the
 * repo's lock, that lock while it waits for a permit), which keeps this simple. Only the join
 * can be interrupted, so the fiber is always started and a drop always recorded.
 */
export const lockedWrite = <A, E, R>(
  repo: string,
  work: Effect.Effect<A, E, R>,
  scope: Scope.Scope,
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let dropped = false;
      const fiber = yield* Effect.forkIn(
        withWriteLock(
          repo,
          Effect.suspend(() => (dropped ? Effect.interrupt : work)),
        ),
        scope,
      );
      return yield* restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            dropped = true;
          }),
        ),
      );
    }),
  );
