import { hostName } from "@gitui/shared";
import { expect, test } from "bun:test";
import { dedupeHosts, parseNearbyHost } from "./state.ts";

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

test("parseNearbyHost takes only a well-formed saved host", () => {
  expect(parseNearbyHost({ key: KEY_A, name: "MacBook" })).toEqual({ key: KEY_A, name: "MacBook" });
  expect(parseNearbyHost({ key: "short", name: "MacBook" })).toBeNull();
  expect(parseNearbyHost({ key: KEY_A, name: " " })).toBeNull();
  expect(parseNearbyHost({ key: KEY_A, name: "x".repeat(64) })).toBeNull();
  expect(parseNearbyHost(null)).toBeNull();
  expect(parseNearbyHost("MacBook")).toBeNull();
});

test("parseNearbyHost checks names as the codec's hostName does", () => {
  const names: unknown[] = [
    "MacBook",
    "  Jan's MacBook ",
    "",
    " ",
    "💻".repeat(63),
    "💻".repeat(64),
  ];
  names.push("a\nb", "a\u2028b", "a\u202eb", "a\u2066b", "a\u061cb", "a\u0000b", 42, null);
  for (const name of names) {
    const parsed = parseNearbyHost({ key: KEY_A, name });
    expect(parsed?.name ?? null).toBe(hostName(name));
  }
});
