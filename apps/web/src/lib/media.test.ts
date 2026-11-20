import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BELOW_LG, type MediaQuery, mediaQueryStore, NARROW } from "./media.ts";

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const list: MediaQuery & { matches: boolean } = {
    matches: initial,
    addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) =>
      listeners.add(cb as () => void),
    removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) =>
      listeners.delete(cb as () => void),
  };
  const change = (next: boolean) => {
    list.matches = next;
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
  const store = mediaQueryStore("(pointer: coarse)", () => media.list);
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

test("the width queries match Tailwind's md and lg breakpoints", () => {
  const theme = readFileSync(Bun.resolveSync("tailwindcss/theme.css", import.meta.dir), "utf8");
  const breakpoint = (name: string) =>
    new RegExp(`--breakpoint-${name}: ([^;]+);`).exec(theme)?.[1];
  expect(NARROW).toBe(`(width < ${breakpoint("md")})`);
  expect(BELOW_LG).toBe(`(width < ${breakpoint("lg")})`);
});
