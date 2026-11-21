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
