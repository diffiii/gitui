import { expect, test } from "bun:test";
import { chooseLanAddress } from "./lan.ts";

test("prefers the default route's address when it is private", () => {
  expect(chooseLanAddress(["10.0.0.2", "192.168.1.5"], "192.168.1.5")).toBe("192.168.1.5");
});

test("falls back to the first private address", () => {
  // No default route, or one that isn't private (a public address on the interface).
  expect(chooseLanAddress(["203.0.113.7", "172.20.10.2"], null)).toBe("172.20.10.2");
  expect(chooseLanAddress(["203.0.113.7", "172.20.10.2"], "203.0.113.7")).toBe("172.20.10.2");
  // A preferred address that isn't one of this machine's.
  expect(chooseLanAddress(["192.168.1.5"], "10.0.0.2")).toBe("192.168.1.5");
});

test("accepts every private range, at both ends", () => {
  for (const a of [
    "10.0.0.1",
    "10.255.255.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.255.254",
  ]) {
    expect(chooseLanAddress([a], null)).toBe(a);
  }
});

test("never picks a public, carrier-grade NAT, loopback, link-local or unspecified address", () => {
  const unsafe = [
    "203.0.113.7",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.255.255",
    "100.64.0.1", // carrier-grade NAT and Tailscale
    "100.127.255.254",
    "100.128.0.1",
    "11.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "0.0.0.0",
  ];
  expect(chooseLanAddress(unsafe, "203.0.113.7")).toBeNull();
  expect(chooseLanAddress([], null)).toBeNull();
});
