import { expect, test } from "bun:test";
import { authProof, CHUNK_SIZE, chunks, frameChunk, parseChunk, sdpFingerprint } from "./nearby.ts";

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

test("authProof depends on the code and both fingerprints", async () => {
  const proof = await authProof("123456", "sha-256 AA", "sha-256 BB");
  expect(proof).toMatch(/^[\w-]{43}$/);
  expect(await authProof("123456", "sha-256 aa", "sha-256 bb")).toBe(proof);
  expect(await authProof("123457", "sha-256 AA", "sha-256 BB")).not.toBe(proof);
  expect(await authProof("123456", "sha-256 BB", "sha-256 AA")).not.toBe(proof);
});

test("sdpFingerprint reads the first fingerprint line", () => {
  const sdp = "v=0\r\na=group:BUNDLE 0\r\na=fingerprint:sha-256 AB:CD\r\na=setup:actpass\r\n";
  expect(sdpFingerprint(sdp)).toBe("sha-256 AB:CD");
  expect(sdpFingerprint("v=0\r\n")).toBeNull();
});
