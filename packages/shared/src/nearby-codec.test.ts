import { expect, test } from "bun:test";
import {
  AUTH_ATTEMPTS,
  ERROR_CODES,
  frameChunk,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  newOfferId,
  REFUSAL_REASONS,
  RENDEZVOUS_PATH,
} from "./nearby.ts";
import {
  decodeChannelMessage,
  decodeClientMessage,
  hostName,
  isId,
  NearbyCodecError,
  parseClientMessage,
  parseServerMessage,
  parseSignal,
  rendezvousUrl,
  sdpFingerprint,
  toHostName,
} from "./nearby-codec.ts";

const parse = (value: unknown): unknown => parseClientMessage(JSON.stringify(value));

const key = "k3Y_-0123456789ab";
const secret = "s3cReT_-".padEnd(43, "0");
const offerId = "offer_0123456789ab";
const b43 = "A".repeat(43);

test("parseClientMessage accepts hello from hosts and guests", () => {
  expect(parse({ type: "hello", role: "guest" })).toEqual({ type: "hello", role: "guest" });
  expect(parse({ type: "hello", role: "host", name: "  Jan's MacBook ", secret, x: 1 })).toEqual({
    type: "hello",
    role: "host",
    name: "Jan's MacBook",
    secret,
  });
  expect(parse({ type: "hello", role: "host", secret })).toBeNull();
  // The key is the rendezvous's to derive; a host sends its secret.
  expect(parse({ type: "hello", role: "host", name: "box", key })).toBeNull();
  expect(parse({ type: "hello", role: "host", name: "box" })).toBeNull();
  expect(parse({ type: "hello", role: "admin", name: "x" })).toBeNull();
  expect(parse({ type: "hello" })).toBeNull();
});

test("parseClientMessage requires a HOST_SECRET-shaped secret from hosts", () => {
  const hello = (secret: unknown) => parse({ type: "hello", role: "host", name: "box", secret });
  expect(hello("a".repeat(43))).toMatchObject({ secret: "a".repeat(43) });
  expect(hello("a".repeat(128))).toMatchObject({ secret: "a".repeat(128) });
  for (const bad of [
    "a".repeat(42),
    "a".repeat(129),
    `${"a".repeat(43)}.`,
    "a b".repeat(15),
    1,
    null,
  ]) {
    expect(hello(bad)).toBeNull();
  }
});

test("parseClientMessage accepts signals and keeps only the contract's fields", () => {
  const offer = { type: "signal", to: "p1", data: { kind: "offer", offerId, sdp: "v=0" } } as const;
  expect(parse({ ...offer, extra: 1, data: { ...offer.data, extra: 2 } })).toEqual(offer);
  // An offer's `resume` goes through when true, and only then.
  expect(parse({ ...offer, data: { ...offer.data, resume: true } })).toEqual({
    ...offer,
    data: { ...offer.data, resume: true },
  });
  for (const resume of [false, "true", 1, null]) {
    expect(parse({ ...offer, data: { ...offer.data, resume } })).toEqual(offer);
  }
  const answer = { type: "signal", to: "p1", data: { kind: "answer", offerId, sdp: "v=0" } };
  expect(parse({ ...answer, data: { ...answer.data, resume: true } })).toEqual(answer);
  const candidate = { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", sdpMid: "0" };
  expect(
    parse({
      type: "signal",
      to: "p1",
      data: {
        kind: "candidate",
        offerId,
        candidate: { ...candidate, sdpMLineIndex: 0, ufrag: "x" },
      },
    }),
  ).toEqual({
    type: "signal",
    to: "p1",
    data: { kind: "candidate", offerId, candidate: { ...candidate, sdpMLineIndex: 0 } },
  });
  const endOfCandidates = { candidate: "", sdpMid: null, sdpMLineIndex: null };
  const end = {
    type: "signal",
    to: "p1",
    data: { kind: "candidate", offerId, candidate: endOfCandidates },
  };
  expect(parse(end)).toEqual(end);
  for (const reason of REFUSAL_REASONS) {
    const refused = { type: "signal", to: "p1", data: { kind: "refused", offerId, reason } };
    expect(parse(refused)).toEqual(refused);
  }
});

test("a refusal or error code this version doesn't know still decodes, as unknown", () => {
  const signal = (value: unknown): unknown => parseSignal(value);
  const refused = (reason: unknown) => ({ kind: "refused", offerId, reason });
  expect(signal(refused("tired-of-you"))).toEqual(refused("unknown"));
  expect(parse({ type: "signal", to: "p1", data: refused("") })).toEqual({
    type: "signal",
    to: "p1",
    data: refused("unknown"),
  });
  const server = (value: unknown): unknown => parseServerMessage(JSON.stringify(value));
  const error = (code: unknown) => ({ type: "error", code, message: "nope" });
  expect(server(error("too-new"))).toEqual(error("unknown"));
  // Only the enum is open: the shape is checked as before.
  for (const reason of [undefined, null, 1, ["busy"]]) expect(signal(refused(reason))).toBeNull();
  for (const code of [undefined, 1, {}]) expect(server(error(code))).toBeNull();
  expect(server({ type: "error", code: "too-new" })).toBeNull();
});

test("parseClientMessage rejects garbage", () => {
  for (const text of ["", "{", "null", "[]", '"hello"', "1"]) {
    expect(parseClientMessage(text)).toBeNull();
  }
  const signal = (data: unknown, to: unknown = "p1") => ({ type: "signal", to, data });
  for (const message of [
    {},
    { type: "welcome", id: "x" },
    { type: "ping" },
    signal({ kind: "offer", offerId, sdp: "v=0" }, 1),
    signal({ kind: "offer", offerId, sdp: "v=0" }, null),
    signal({ kind: "offer", offerId, sdp: "v=0" }, "a b"),
    { type: "signal", data: { kind: "offer", offerId, sdp: "v=0" } },
    signal({ kind: "offer", sdp: "v=0" }),
    signal({ kind: "offer", offerId: "short", sdp: "v=0" }),
    signal({ kind: "offer", offerId }),
    signal({ kind: "answer", offerId, sdp: 1 }),
    signal({ kind: "bye", offerId, sdp: "v=0" }),
    signal({ kind: "refused", offerId, reason: 1 }),
    signal({ kind: "refused", offerId }),
    signal(null),
    signal({ kind: "candidate", offerId }),
    signal({ kind: "candidate", offerId, candidate: "candidate:1" }),
    signal({ kind: "candidate", offerId, candidate: { candidate: 1 } }),
    signal({ kind: "candidate", offerId, candidate: { candidate: "", sdpMid: 0 } }),
    signal({ kind: "candidate", offerId, candidate: { candidate: "", sdpMLineIndex: -1 } }),
    signal({ kind: "candidate", offerId, candidate: { candidate: "", sdpMLineIndex: 0.5 } }),
    signal({ kind: "candidate", offerId, candidate: { candidate: "", sdpMLineIndex: "0" } }),
    signal({ kind: "candidate", offerId, candidate: { candidate: "", sdpMLineIndex: 65536 } }),
  ]) {
    expect(parse(message)).toBeNull();
  }
  const long = JSON.stringify(
    signal({ kind: "offer", offerId, sdp: "x".repeat(MAX_MESSAGE_LENGTH) }),
  );
  expect(parseClientMessage(long)).toBeNull();
});

test("decoders say what is wrong", () => {
  expect(() =>
    decodeClientMessage('{"type":"hello","role":"host","name":"a\\nb","secret":"x"}'),
  ).toThrow(new NearbyCodecError("invalid name"));
  expect(() => decodeClientMessage("{")).toThrow(new NearbyCodecError("not JSON"));
});

test("parseServerMessage rebuilds every message a peer handles", () => {
  const server = (value: unknown): unknown => parseServerMessage(JSON.stringify(value));
  expect(server({ type: "welcome", id: "p1", x: 1 })).toEqual({ type: "welcome", id: "p1" });
  expect(server({ type: "gone", id: "p1" })).toEqual({ type: "gone", id: "p1" });
  expect(server({ type: "pong" })).toEqual({ type: "pong" });
  for (const code of ERROR_CODES) {
    expect(server({ type: "error", code, message: "nope", x: 1 })).toEqual({
      type: "error",
      code,
      message: "nope",
    });
  }
  const data = { kind: "answer", offerId, sdp: "v=0" };
  expect(server({ type: "signal", from: "p1", data: { ...data, x: 1 } })).toEqual({
    type: "signal",
    from: "p1",
    data,
  });
  // Hosts that break the contract are dropped, not the whole list.
  const host = { id: "p1", name: "box", key };
  expect(
    server({
      type: "hosts",
      hosts: [host, { ...host, name: "evil\u202Ekoob" }, { ...host, key: "short" }, null],
    }),
  ).toEqual({ type: "hosts", hosts: [host] });
  for (const bad of [
    { type: "welcome" },
    { type: "hosts", hosts: {} },
    { type: "signal", from: "p1", data: { kind: "answer", sdp: "v=0" } },
    { type: "error", code: "rate-limit", message: 1 },
    { type: "error", message: "no code" },
    { type: "error", code: 1, message: "code isn't a string" },
    { type: "hello", role: "guest" },
  ]) {
    expect(server(bad)).toBeNull();
  }
  expect(parseServerMessage("nope")).toBeNull();
});

test("parseSignal bounds SDPs", () => {
  expect(
    parseSignal({ kind: "offer", offerId, sdp: "x".repeat(MAX_MESSAGE_LENGTH) }),
  ).not.toBeNull();
  expect(
    parseSignal({ kind: "offer", offerId, sdp: "x".repeat(MAX_MESSAGE_LENGTH + 1) }),
  ).toBeNull();
});

test("newOfferId makes distinct valid ids", () => {
  const a = newOfferId();
  expect(parseSignal({ kind: "answer", offerId: a, sdp: "" })).not.toBeNull();
  expect(newOfferId()).not.toBe(a);
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
  expect(hostName("👩‍💻 box")).toBe("👩‍💻 box");
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

test("isId takes unsigned 32-bit integers", () => {
  for (const ok of [0, 1, 0xffff_ffff]) expect(isId(ok)).toBe(true);
  for (const bad of [-1, 0.5, 0x1_0000_0000, "1", null]) expect(isId(bad)).toBe(false);
});

test("decodeChannelMessage reads each side's messages only", () => {
  const guest = (value: unknown): unknown => decodeChannelMessage(JSON.stringify(value), "guest");
  const host = (value: unknown): unknown => decodeChannelMessage(JSON.stringify(value), "host");
  const req = { t: "req", id: 1, method: "GET", path: "/api/config", headers: [["a", "b"]] };
  expect(guest({ ...req, x: 1 })).toEqual({ kind: "message", message: req });
  expect(guest({ t: "pake", y: b43 })).toEqual({ kind: "message", message: { t: "pake", y: b43 } });
  expect(guest({ t: "pake-fail" })).toEqual({ kind: "message", message: { t: "pake-fail" } });
  expect(guest({ t: "resume", nonce: "n".repeat(22), proof: b43 })).toMatchObject({
    kind: "message",
  });
  expect(host({ t: "pake", y: b43, confirm: b43 })).toMatchObject({ kind: "message" });
  expect(host({ t: "auth-fail", attemptsLeft: AUTH_ATTEMPTS })).toMatchObject({ kind: "message" });
  expect(host({ t: "res", id: 1, status: 200, headers: [] })).toMatchObject({ kind: "message" });
  // Each side's messages, from the other side, are invalid.
  expect(host(req)).toMatchObject({ kind: "invalid", id: 1 });
  expect(guest({ t: "auth-ok" })).toMatchObject({ kind: "invalid", id: null });
  expect(host({ t: "pake", y: b43 })).toMatchObject({ kind: "invalid" });
  for (const bad of [
    { ...req, method: "G T" },
    { ...req, path: "//evil.example/x" },
    { ...req, path: "/\\evil.example/x" },
    { ...req, path: "api" },
    { ...req, headers: [["a"]] },
  ]) {
    expect(guest(bad)).toMatchObject({ kind: "invalid", id: 1 });
  }
  expect(guest({ t: "end", id: -1 })).toEqual({
    kind: "invalid",
    id: null,
    reason: "no request id",
  });
  expect(host({ t: "auth-fail", attemptsLeft: AUTH_ATTEMPTS + 1 })).toMatchObject({
    kind: "invalid",
  });
  expect(host({ t: "session", token: "short" })).toMatchObject({ kind: "invalid" });
  // 43 characters that aren't the one encoding of 32 bytes: stray low bits in the last one.
  const loose = `${"A".repeat(42)}B`;
  expect(guest({ t: "pake", y: loose })).toMatchObject({
    kind: "invalid",
    reason: "invalid share",
  });
  expect(guest({ t: "pake-confirm", confirm: loose })).toMatchObject({ kind: "invalid" });
  expect(guest({ t: "resume", nonce: "n".repeat(22), proof: loose })).toMatchObject({
    kind: "invalid",
  });
  expect(host({ t: "pake", y: b43, confirm: loose })).toMatchObject({
    kind: "invalid",
    reason: "invalid tag",
  });
  expect(host({ t: "pake", y: loose, confirm: b43 })).toMatchObject({ kind: "invalid" });
  expect(host({ t: "resume-ok", proof: loose })).toMatchObject({ kind: "invalid" });
  expect(host({ t: "session", token: loose })).toMatchObject({ kind: "invalid" });
  expect(decodeChannelMessage("nope", "host")).toEqual({
    kind: "invalid",
    id: null,
    reason: "not JSON",
  });
  expect(decodeChannelMessage("[]", "host")).toMatchObject({ kind: "invalid", id: null });
});

test("decodeChannelMessage reads binary frames", () => {
  const frame = frameChunk(7, new Uint8Array([1, 2]));
  expect(decodeChannelMessage(frame, "host")).toEqual({
    kind: "chunk",
    id: 7,
    payload: new Uint8Array([1, 2]),
  });
  expect(decodeChannelMessage(frame.slice().buffer, "guest")).toMatchObject({
    kind: "chunk",
    id: 7,
  });
  expect(decodeChannelMessage(new Uint8Array(3), "guest")).toMatchObject({ kind: "invalid" });
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
