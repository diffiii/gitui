import { expect, test } from "bun:test";
import { afterRejectedResume, dedupeHosts, findHost, opening, parseNearbyHost } from "./state.ts";

const KEY_A = "a".repeat(16);
const KEY_B = "b".repeat(16);
const KEY_C = "c".repeat(16);

test("dedupeHosts lists each key once, where it first appears, with its newest socket", () => {
  const hosts = [
    { id: "p1", name: "MacBook", key: KEY_A },
    { id: "p2", name: "Desktop", key: KEY_B },
    { id: "p3", name: "MacBook", key: KEY_A },
    { id: "p4", name: "MacBook", key: KEY_C },
  ];
  expect(dedupeHosts(hosts)).toEqual([
    { id: "p3", name: "MacBook", key: KEY_A },
    { id: "p2", name: "Desktop", key: KEY_B },
    { id: "p4", name: "MacBook", key: KEY_C },
  ]);
  expect(dedupeHosts([])).toEqual([]);
});

test("findHost finds the host by key, then a restarted one by its unique name", () => {
  const saved = { key: KEY_A, name: "MacBook" };
  const listed = { id: "p1", name: "MacBook", key: KEY_A };
  const restarted = { id: "p2", name: "MacBook", key: KEY_B };
  const other = { id: "p3", name: "Desktop", key: KEY_C };

  expect(findHost([other, listed], saved)).toEqual({ kind: "listed", host: listed });
  // The key wins over a name match: both runs can overlap for a moment.
  expect(findHost([restarted, listed], saved)).toEqual({ kind: "listed", host: listed });
  expect(findHost([other, restarted], saved)).toEqual({ kind: "restarted", host: restarted });
  // Two computers by that name: no telling which.
  const twin = { id: "p4", name: "MacBook", key: "d".repeat(16) };
  expect(findHost([restarted, twin], saved)).toEqual({ kind: "missing" });
  expect(findHost([other], saved)).toEqual({ kind: "missing" });
});

test("a channel opens with resume when there is a token, else with the code", () => {
  expect(opening("t0ken")).toEqual({ t: "resume", token: "t0ken" });
  expect(opening(null)).toEqual({ t: "auth" });
  expect(opening("")).toEqual({ t: "auth" });
});

test("a rejected resume asks for the code on the same channel while the host takes attempts", () => {
  expect(afterRejectedResume(2)).toBe("ask-code");
  expect(afterRejectedResume(0)).toBe("reopen");
});

test("parseNearbyHost takes only a well-formed saved host", () => {
  expect(parseNearbyHost({ key: KEY_A, name: "MacBook" })).toEqual({ key: KEY_A, name: "MacBook" });
  expect(parseNearbyHost({ key: "short", name: "MacBook" })).toBeNull();
  expect(parseNearbyHost({ key: KEY_A, name: " " })).toBeNull();
  expect(parseNearbyHost({ key: KEY_A, name: "x".repeat(64) })).toBeNull();
  expect(parseNearbyHost(null)).toBeNull();
  expect(parseNearbyHost("MacBook")).toBeNull();
});
