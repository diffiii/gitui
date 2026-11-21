import { expect, test } from "bun:test";
import {
  LARGE_PAYLOAD,
  POLL_MS,
  pollInterval,
  refreshedByMutations,
  SLOW_POLL_MS,
} from "./polling.ts";

test("pollInterval polls only payloads past LARGE_PAYLOAD slowly", () => {
  expect(pollInterval(undefined)).toBe(POLL_MS);
  expect(pollInterval(0)).toBe(POLL_MS);
  expect(pollInterval(LARGE_PAYLOAD)).toBe(POLL_MS);
  expect(pollInterval(LARGE_PAYLOAD + 1)).toBe(SLOW_POLL_MS);
});

test("refreshedByMutations leaves only loaded commit details alone", () => {
  expect(refreshedByMutations(["/r", "status"], true)).toBe(true);
  expect(refreshedByMutations(["/r", "diff", "a.ts"], true)).toBe(true);
  expect(refreshedByMutations(["/r", "commit", "abc"], true)).toBe(false);
  expect(refreshedByMutations(["/r", "commit", "abc"], false)).toBe(true);
  expect(refreshedByMutations(["/r", "log", null, false, 300], true)).toBe(true);
});
