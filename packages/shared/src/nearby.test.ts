import { expect, test } from "bun:test";
import { CHUNK_SIZE, chunks, frameChunk, HOST_KEY, hostKey, parseChunk } from "./nearby.ts";

test("frameChunk and parseChunk round-trip the id and payload", () => {
  const payload = new Uint8Array([1, 2, 3]);
  expect(parseChunk(frameChunk(0xdeadbeef, payload))).toEqual({ id: 0xdeadbeef, payload });
  expect(() => frameChunk(1, new Uint8Array(CHUNK_SIZE + 1))).toThrow(RangeError);
  expect(() => parseChunk(new Uint8Array(3))).toThrow(RangeError);
});

test("chunks splits a body into CHUNK_SIZE pieces", () => {
  const sizes = [...chunks(new Uint8Array(CHUNK_SIZE * 2 + 5))].map((c) => c.byteLength);
  expect(sizes).toEqual([CHUNK_SIZE, CHUNK_SIZE, 5]);
  expect([...chunks(new Uint8Array(0))]).toEqual([]);
});

test("hostKey is the first 16 bytes of SHA-256(label ‖ secret), base64url", () => {
  // printf 'gitui-nearby-host-keyabc' | openssl dgst -sha256 -binary | head -c 16 | base64
  expect(hostKey("abc")).toBe("AUVnxQpqbg-ntJF0DrbTxw");
  const secret = "s".repeat(43);
  expect(hostKey(secret)).toMatch(HOST_KEY);
  expect(hostKey(secret)).toHaveLength(22);
  expect(hostKey(`${secret}t`)).not.toBe(hostKey(secret));
});
