import { expect, test } from "bun:test";
import {
  AUTH_ATTEMPTS,
  ERROR_CODES,
  frameChunk,
  MAX_MESSAGE_LENGTH,
  newOfferId,
  REFUSAL_REASONS,
} from "./nearby.ts";
import {
  decodeChannelMessage,
  decodeClientMessage,
  decodeServerMessage,
  decodeSignal,
  NearbyCodecError,
  parseClientMessage,
  parseServerMessage,
  parseSignal,
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
  // The rendezvous relays any slug unchanged, and only slugs.
  const relayed = { type: "signal", to: "p1", data: refused("tired-of-you") };
  expect(parse(relayed)).toEqual(relayed);
  for (const reason of ["", "Busy", "busy now", "x".repeat(33)]) {
    expect(parse({ type: "signal", to: "p1", data: refused(reason) })).toBeNull();
    expect(signal(refused(reason))).toBeNull();
  }
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
  expect(() => decodeClientMessage("{}")).toThrow(new NearbyCodecError("missing type"));
  expect(() => decodeClientMessage('{"type":"bye"}')).toThrow(new NearbyCodecError("invalid type"));
  expect(() =>
    decodeClientMessage('{"type":"signal","to":"p1","data":{"kind":"answer","sdp":""}}'),
  ).toThrow(new NearbyCodecError("missing data.offerId"));
  // A tag inside a nested union, or inside a field, is named too.
  const said = (message: object) => () => decodeClientMessage(JSON.stringify(message));
  expect(said({ type: "hello", role: "admin" })).toThrow(new NearbyCodecError("invalid role"));
  expect(said({ type: "hello" })).toThrow(new NearbyCodecError("missing role"));
  expect(said({ type: "signal", to: "p1", data: { offerId } })).toThrow(
    new NearbyCodecError("missing data.kind"),
  );
  expect(said({ type: "signal", to: "p1", data: { kind: "x", offerId } })).toThrow(
    new NearbyCodecError("invalid data.kind"),
  );
  expect(said({ type: "signal", to: "p1", data: "x" })).toThrow(
    new NearbyCodecError("invalid data"),
  );
});

test("a getter that throws is an invalid message, not a crash", () => {
  const value = { kind: "answer", offerId: "o".repeat(16) };
  Object.defineProperty(value, "sdp", {
    enumerable: true,
    get: () => {
      throw new Error("boom");
    },
  });
  expect(() => decodeSignal(value)).toThrow(NearbyCodecError);
  expect(parseSignal(value)).toBeNull();
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

test("an invalid channel message names its request only by an unsigned 32-bit id", () => {
  const id = (value: unknown) => {
    const incoming = decodeChannelMessage(JSON.stringify({ t: "end", id: value, x: 1 }), "guest");
    return incoming.kind === "invalid" ? incoming.id : "valid";
  };
  for (const ok of [0, 1, 0xffff_ffff]) expect(id(ok)).toBe("valid");
  for (const bad of [-1, 0.5, 0x1_0000_0000, "1", null]) expect(id(bad)).toBeNull();
  const req = { t: "req", id: 0xffff_ffff, method: "G T", path: "/", headers: [] };
  expect(decodeChannelMessage(JSON.stringify(req), "guest")).toMatchObject({ id: 0xffff_ffff });
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
  // `locked` is kept only as true, on a last failure.
  const fail = (value: object) => ({ kind: "message", message: { t: "auth-fail", ...value } });
  const locked = { attemptsLeft: 0, locked: true };
  expect(host({ t: "auth-fail", ...locked })).toEqual(fail(locked));
  expect(host({ t: "auth-fail", attemptsLeft: 1, locked: true })).toEqual(
    fail({ attemptsLeft: 1 }),
  );
  expect(host({ t: "auth-fail", attemptsLeft: 0, locked: 1 })).toEqual(fail({ attemptsLeft: 0 }));
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
    reason: "invalid id",
  });
  expect(host({ t: "auth-fail", attemptsLeft: AUTH_ATTEMPTS + 1 })).toMatchObject({
    kind: "invalid",
  });
  expect(host({ t: "session", token: "short" })).toMatchObject({ kind: "invalid" });
  // 43 characters that aren't the one encoding of 32 bytes: stray low bits in the last one.
  const loose = `${"A".repeat(42)}B`;
  expect(guest({ t: "pake", y: loose })).toMatchObject({
    kind: "invalid",
    reason: "invalid y",
  });
  expect(guest({ t: "pake-confirm", confirm: loose })).toMatchObject({ kind: "invalid" });
  expect(guest({ t: "resume", nonce: "n".repeat(22), proof: loose })).toMatchObject({
    kind: "invalid",
  });
  expect(host({ t: "pake", y: b43, confirm: loose })).toMatchObject({
    kind: "invalid",
    reason: "invalid confirm",
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

const sdp = "v=0";
const candidate = {
  candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
const signals = [
  { kind: "offer", offerId, sdp },
  { kind: "offer", offerId, sdp, resume: true },
  { kind: "answer", offerId, sdp },
  { kind: "candidate", offerId, candidate },
  { kind: "candidate", offerId, candidate: { candidate: "", sdpMid: null, sdpMLineIndex: null } },
  { kind: "refused", offerId, reason: "busy" },
];
/** `decodeChannelMessage` for `from`'s messages, as a value that throws unless it is one. */
const channel = (from: "guest" | "host") => (value: unknown) => {
  const text = JSON.stringify(value);
  const incoming =
    from === "guest" ? decodeChannelMessage(text, "guest") : decodeChannelMessage(text, "host");
  if (incoming.kind !== "message") throw new Error(JSON.stringify(incoming));
  return incoming.message;
};
// Each decoder production reads with, and one valid message of every kind it reads. A
// RelayedSignal is read inside a ClientMessage, and a HostInfo inside a ServerMessage.
const valid: [string, (value: unknown) => unknown, object[]][] = [
  ["SignalData", decodeSignal, signals],
  [
    "ClientMessage",
    (value) => decodeClientMessage(JSON.stringify(value)),
    [
      { type: "hello", role: "guest" },
      { type: "hello", role: "host", name: "box", secret },
      ...signals.map((data) => ({ type: "signal", to: "p1", data })),
    ],
  ],
  [
    "ServerMessage",
    (value) => decodeServerMessage(JSON.stringify(value)),
    [
      { type: "welcome", id: "p1" },
      { type: "hosts", hosts: [{ id: "p1", name: "box", key }] },
      ...signals.map((data) => ({ type: "signal", from: "p1", data })),
      { type: "gone", id: "p1" },
      { type: "error", code: "rate-limit", message: "slow down" },
      { type: "pong" },
    ],
  ],
  [
    "GuestMessage",
    channel("guest"),
    [
      { t: "pake", y: b43 },
      { t: "pake-confirm", confirm: b43 },
      { t: "pake-fail" },
      { t: "resume", nonce: "n".repeat(22), proof: b43 },
      { t: "req", id: 1, method: "GET", path: "/api/config", headers: [["a", "b"]] },
      { t: "end", id: 1 },
      { t: "cancel", id: 1 },
    ],
  ],
  [
    "HostMessage",
    channel("host"),
    [
      { t: "pake", y: b43, confirm: b43 },
      { t: "resume-ok", proof: b43 },
      { t: "auth-ok" },
      { t: "session", token: b43 },
      { t: "auth-fail", attemptsLeft: 2 },
      { t: "auth-fail", attemptsLeft: 0, locked: true },
      { t: "res", id: 1, status: 200, headers: [] },
      { t: "end", id: 1 },
      { t: "abort", id: 1, message: "boom" },
    ],
  ],
];

test("every decoder gives valid messages back as they were sent", () => {
  for (const [name, decode, messages] of valid) {
    for (const message of messages) expect([name, decode(message)]).toEqual([name, message]);
  }
});

test("every decoder strips fields the contract doesn't have, at every level", () => {
  /** `value` with an `extra` field added to it and to every object inside it. */
  const withExtras = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withExtras);
    if (typeof value !== "object" || value === null) return value;
    const entries = Object.entries(value).map(([k, v]) => [k, withExtras(v)]);
    return { ...Object.fromEntries(entries), extra: 1 };
  };
  for (const [name, decode, messages] of valid) {
    for (const message of messages) {
      expect([name, decode(withExtras(message))]).toEqual([name, message]);
    }
  }
});
