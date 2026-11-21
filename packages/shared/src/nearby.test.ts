import { expect, test } from "bun:test";
import {
  CHUNK_SIZE,
  chunks,
  frameChunk,
  HOST_KEY,
  hostKey,
  hostName,
  MAX_NAME_LENGTH,
  MAX_PRINTABLE_LENGTH,
  parseChunk,
  printable,
  RENDEZVOUS_PATH,
  rendezvousUrl,
  sdpFingerprint,
  toHostName,
} from "./nearby.ts";

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

test("hostName trims and bounds names by code point and rejects control and bidi characters", () => {
  expect(hostName(" box ")).toBe("box");
  expect(hostName("a".repeat(MAX_NAME_LENGTH))).toBe("a".repeat(MAX_NAME_LENGTH));
  // Lengths count code points: an emoji is one.
  expect(hostName("💻".repeat(MAX_NAME_LENGTH))).not.toBeNull();
  expect(hostName("💻".repeat(MAX_NAME_LENGTH + 1))).toBeNull();
  expect(hostName("a".repeat(MAX_NAME_LENGTH + 1))).toBeNull();
  expect(hostName("   ")).toBeNull();
  expect(hostName("")).toBeNull();
  expect(hostName(42)).toBeNull();
  for (const bad of ["\n", "\u0000", "\u009b", "\u202E", "\u2066", "\u200F", "\u061C", "\u2028"]) {
    expect(hostName(`a${bad}b`)).toBeNull();
  }
  // Emoji sequences keep their joiners.
  expect(hostName("👩\u200d💻 box")).toBe("👩\u200d💻 box");
});

test("printable drops control and bidi characters and caps the length", () => {
  expect(printable("a\u001b[2Jb\nc\u202Ed\u2028e\u2066f")).toBe("a[2Jbcdef");
  expect(printable("💻".repeat(MAX_PRINTABLE_LENGTH))).toBe("💻".repeat(MAX_PRINTABLE_LENGTH));
  expect(printable("💻".repeat(MAX_PRINTABLE_LENGTH + 1))).toBe(
    `${"💻".repeat(MAX_PRINTABLE_LENGTH - 1)}…`,
  );
  expect(printable("abcdef", 4)).toBe("abc…");
});

test("toHostName drops what hostName refuses and cuts by code point", () => {
  expect(toHostName(" my\u202E-box\n ")).toBe("my-box");
  expect(toHostName("💻".repeat(MAX_NAME_LENGTH + 5))).toBe("💻".repeat(MAX_NAME_LENGTH));
  expect(toHostName("\u0007\u202E")).toBeNull();
});

test("rendezvousUrl takes ws: and wss: origins only", () => {
  expect(rendezvousUrl("wss://rendezvous.example")).toBe(
    `wss://rendezvous.example${RENDEZVOUS_PATH}`,
  );
  expect(rendezvousUrl("ws://127.0.0.1:8787")).toBe(`ws://127.0.0.1:8787${RENDEZVOUS_PATH}`);
  for (const bad of [
    "https://x.example",
    "wss://x.example/",
    "wss://x.example/path",
    "wss://x.example?q",
    "WSS://x.example",
    "",
    "nope",
  ]) {
    expect(rendezvousUrl(bad)).toBeNull();
  }
});

const hex = (n: number) =>
  Array.from({ length: 32 }, (_, i) => ((i * n) & 0xff).toString(16).padStart(2, "0")).join(":");

test("sdpFingerprint reads a single SHA-256 fingerprint", () => {
  const print = hex(7);
  const sdp = `v=0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${print.toUpperCase()}\r\na=setup:actpass\r\n`;
  // Normalized to lowercase: sdpFingerprint is the one place that does it.
  expect(sdpFingerprint(sdp) as string).toBe(`sha-256 ${print}`);
  expect(sdpFingerprint(sdp.replaceAll("\r\n", "\n")) as string).toBe(`sha-256 ${print}`);
  expect(sdpFingerprint("v=0\r\n")).toBeNull();
});

test("sdpFingerprint refuses SDPs with more than one fingerprint, or another hash", () => {
  const a = `a=fingerprint:sha-256 ${hex(3)}`;
  const b = `a=fingerprint:sha-256 ${hex(5)}`;
  // Session-level plus media-level.
  expect(sdpFingerprint(`v=0\r\n${a}\r\nm=application 9 x\r\n${b}\r\n`)).toBeNull();
  // The same one twice is still two lines.
  expect(sdpFingerprint(`v=0\r\n${a}\r\n${a}\r\n`)).toBeNull();
  // SHA-1 next to SHA-256, and SHA-1 alone.
  const sha1 = "a=fingerprint:sha-1 " + hex(3).split(":").slice(0, 20).join(":");
  expect(sdpFingerprint(`v=0\r\n${sha1}\r\n${a}\r\n`)).toBeNull();
  expect(sdpFingerprint(`v=0\r\n${sha1}\r\n`)).toBeNull();
  expect(sdpFingerprint(`v=0\r\na=fingerprint:sha-512 ${hex(3)}\r\n`)).toBeNull();
  // A second line hidden behind a bare CR or LF, which some parsers don't split on.
  expect(sdpFingerprint(`v=0\r\n${a}\n${b}\r\n`)).toBeNull();
  expect(sdpFingerprint(`v=0\r\n${a}\r${b}\r\n`)).toBeNull();
  // Malformed values.
  expect(sdpFingerprint(`v=0\r\na=fingerprint:sha-256 ${hex(3).slice(3)}\r\n`)).toBeNull();
  expect(sdpFingerprint(`v=0\r\na=fingerprint:sha-256 ${hex(3)} extra\r\n`)).toBeNull();
});
