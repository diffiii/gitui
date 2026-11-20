import { useSyncExternalStore } from "react";

// Media queries the components act on in JS. Each mirrors a Tailwind variant, so markup styled with
// that variant and code branching on the query switch together; media.test.ts checks the widths
// against Tailwind's `--breakpoint-*`. Prefer the variant where CSS can do the job.

/** Phones: below `--breakpoint-md`, where two-pane views show one pane at a time (`max-md:`). */
export const NARROW = "(width < 48rem)";
/** Below `--breakpoint-lg`, too narrow for the Branches view's three columns (`max-lg:`). */
export const BELOW_LG = "(width < 64rem)";
/**
 * A finger rather than a mouse (`pointer-coarse:`): nothing hovers, so hover-only affordances
 * must show, and tap targets must be bigger.
 */
export const COARSE = "(pointer: coarse)";

export type MediaQuery = Pick<
  MediaQueryList,
  "matches" | "addEventListener" | "removeEventListener"
>;

/** An external store for whether `query` matches. It calls `matchMedia` on first use. */
export function mediaQueryStore(query: string, matchMedia: (query: string) => MediaQuery) {
  let list: MediaQuery | undefined;
  const get = () => (list ??= matchMedia(query));
  return {
    subscribe: (cb: () => void) => {
      const l = get();
      l.addEventListener("change", cb);
      return () => l.removeEventListener("change", cb);
    },
    getSnapshot: () => get().matches,
  };
}

const stores = new Map<string, ReturnType<typeof mediaQueryStore>>();

export function useMediaQuery(query: string): boolean {
  let store = stores.get(query);
  if (!store) {
    store = mediaQueryStore(query, (q) => window.matchMedia(q));
    stores.set(query, store);
  }
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
