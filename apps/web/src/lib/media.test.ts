import { expect, test } from "bun:test";
import { mediaQueryStore } from "./media.ts";

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  } as unknown as MediaQueryList;
  const change = (next: boolean) => {
    (list as { matches: boolean }).matches = next;
    listeners.forEach((l) => l());
  };
  return { list, listeners, change };
}

test("reads matchMedia lazily and only once", () => {
  const media = fakeMedia(true);
  const queries: string[] = [];
  const store = mediaQueryStore("(width < 48rem)", (q) => {
    queries.push(q);
    return media.list;
  });
  expect(queries).toEqual([]);
  expect(store.getSnapshot()).toBe(true);
  store.subscribe(() => {});
  expect(queries).toEqual(["(width < 48rem)"]);
});

test("notifies subscribers of changes until they unsubscribe", () => {
  const media = fakeMedia(false);
  const store = mediaQueryStore("(hover: none)", () => media.list);
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  media.change(true);
  expect(calls).toBe(1);
  expect(store.getSnapshot()).toBe(true);
  unsubscribe();
  expect(media.listeners.size).toBe(0);
  media.change(false);
  expect(calls).toBe(1);
  expect(store.getSnapshot()).toBe(false);
});
