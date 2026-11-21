import { expect, test } from "bun:test";
import { visibleRange } from "./windowing.ts";

test("visibleRange pads the top of the list only by the rows that exist", () => {
  expect(visibleRange({ first: 0, span: 10 }, 100, 5)).toEqual({ start: 0, end: 15 });
});

test("visibleRange pads both sides in the middle of the list", () => {
  expect(visibleRange({ first: 50, span: 10 }, 100, 5)).toEqual({ start: 45, end: 65 });
});

test("visibleRange clamps the end to the row count", () => {
  expect(visibleRange({ first: 95, span: 10 }, 100, 5)).toEqual({ start: 90, end: 100 });
});

test("visibleRange mounts nothing for an empty list", () => {
  expect(visibleRange({ first: 0, span: 10 }, 0, 5)).toEqual({ start: 0, end: 0 });
});

test("visibleRange is empty at the end when scrolled past a list that shrank", () => {
  expect(visibleRange({ first: 500, span: 10 }, 100, 5)).toEqual({ start: 100, end: 100 });
});
