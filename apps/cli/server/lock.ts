import { Effect, Semaphore } from "effect";

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
