import { expect, test } from "bun:test";
import { LARGE_PAYLOAD, POLL_MS, pollInterval, SLOW_POLL_MS } from "./polling.ts";

test("pollInterval polls only payloads past LARGE_PAYLOAD slowly", () => {
  expect(pollInterval(undefined)).toBe(POLL_MS);
  expect(pollInterval(0)).toBe(POLL_MS);
  expect(pollInterval(LARGE_PAYLOAD)).toBe(POLL_MS);
  expect(pollInterval(LARGE_PAYLOAD + 1)).toBe(SLOW_POLL_MS);
});
