const tails = new Map<string, Promise<void>>();

/** Run `fn` after every earlier call for the same `key` has settled (a per-key FIFO mutex). */
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(() => fn());
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
