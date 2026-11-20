import { expect, test } from "bun:test";
import { equalBytes, fromBase64Url, randomId, toBase64Url } from "./bytes.ts";

test("base64url round-trips and refuses other lengths and non-canonical encodings", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  const text = toBase64Url(bytes);
  expect(text).toMatch(/^[\w-]{43}$/);
  expect(fromBase64Url(text, 32)).toEqual(bytes);
  expect(fromBase64Url(text, 31)).toBeNull();
  expect(fromBase64Url(`${text.slice(0, 42)}B`, 32)).toBeNull(); // stray low bits
  expect(fromBase64Url(`${text.slice(0, 42)}+`, 32)).toBeNull();
});

test("randomId makes distinct base64url ids of the given size", () => {
  expect(randomId(16)).toMatch(/^[\w-]{22}$/);
  expect(randomId(16)).not.toBe(randomId(16));
});

test("equalBytes compares contents and lengths", () => {
  expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
  expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
  expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
});
