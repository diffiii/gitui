// For tests: starts something that lives in a scope (a rendezvous client, a nearby host) the way
// a caller would, and stops it by closing the scope.
import { Effect, Exit, Scope } from "effect";

/**
 * Runs `effect` in a new scope, synchronously, and returns what it made with `stop`, which
 * closes the scope.
 */
export function startScoped<A>(
  effect: Effect.Effect<A, never, Scope.Scope>,
): A & { stop: () => Promise<void> } {
  const scope = Effect.runSync(Scope.make());
  const value = Effect.runSync(Scope.provide(scope)(effect));
  return Object.assign(value as object, {
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }) as A & { stop: () => Promise<void> };
}
