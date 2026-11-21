import { expect, test } from "bun:test";
import { asksBeforeOpening } from "./asksBeforeOpening.ts";

const config = { initialRepo: "/r/init", recent: ["/r/x", "/r/y"] };

test("a nearby device never asks, with or without a config", () => {
  expect(asksBeforeOpening(config, "/r/z", "nearby")).toBe(false);
  expect(asksBeforeOpening(undefined, "/r/z", "nearby")).toBe(false);
});

test("without a config, paired and dev ask", () => {
  expect(asksBeforeOpening(undefined, "/r/x", "paired")).toBe(true);
  expect(asksBeforeOpening(undefined, "/r/x", "dev")).toBe(true);
});

test("the initial repo doesn't ask, even when the recent list is empty", () => {
  const c = { initialRepo: "/r/init", recent: [] };
  expect(asksBeforeOpening(c, "/r/init", "paired")).toBe(false);
  expect(asksBeforeOpening(c, "/r/init", "dev")).toBe(false);
});

test("a recent repo doesn't ask", () => {
  expect(asksBeforeOpening(config, "/r/y", "paired")).toBe(false);
  expect(asksBeforeOpening(config, "/r/y", "dev")).toBe(false);
});

test("an unknown repo asks", () => {
  expect(asksBeforeOpening(config, "/r/z", "paired")).toBe(true);
  expect(asksBeforeOpening(config, "/r/z", "dev")).toBe(true);
  expect(asksBeforeOpening({ initialRepo: null, recent: [] }, "/r/z", "paired")).toBe(true);
});

test("another spelling of a recent repo asks, as the comparison is exact", () => {
  expect(asksBeforeOpening(config, "/r/x/", "paired")).toBe(true);
  expect(asksBeforeOpening(config, "/r/x/src", "paired")).toBe(true);
});
