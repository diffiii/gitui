import { expect, test } from "bun:test";
import { hostName, MAX_NAME_LENGTH, parseClientMessage } from "./messages.ts";

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

test("parseClientMessage accepts hello from hosts and guests", () => {
  expect(parse({ type: "hello", role: "guest" })).toEqual({ type: "hello", role: "guest" });
  expect(parse({ type: "hello", role: "host", name: "  Jan's MacBook " })).toEqual({
    type: "hello",
    role: "host",
    name: "Jan's MacBook",
  });
  expect(parse({ type: "hello", role: "host" })).toBeNull();
  expect(parse({ type: "hello", role: "admin", name: "x" })).toBeNull();
  expect(parse({ type: "hello" })).toBeNull();
});

test("parseClientMessage accepts signals and keeps only the contract's fields", () => {
  const offer = { type: "signal", to: "p1", data: { kind: "offer", sdp: "v=0" } } as const;
  expect(parse({ ...offer, extra: 1, data: { ...offer.data, extra: 2 } })).toEqual(offer);
  expect(parse({ type: "signal", to: "p1", data: { kind: "answer", sdp: "v=0" } })).toEqual({
    type: "signal",
    to: "p1",
    data: { kind: "answer", sdp: "v=0" },
  });
  const candidate = { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host", sdpMid: "0" };
  expect(
    parse({
      type: "signal",
      to: "p1",
      data: { kind: "candidate", candidate: { ...candidate, sdpMLineIndex: 0, ufrag: "x" } },
    }),
  ).toEqual({
    type: "signal",
    to: "p1",
    data: { kind: "candidate", candidate: { ...candidate, sdpMLineIndex: 0 } },
  });
  const endOfCandidates = { candidate: "", sdpMid: null, sdpMLineIndex: null };
  expect(
    parse({ type: "signal", to: "p1", data: { kind: "candidate", candidate: endOfCandidates } }),
  ).toEqual({ type: "signal", to: "p1", data: { kind: "candidate", candidate: endOfCandidates } });
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
    signal({ kind: "offer", sdp: "v=0" }, 1),
    signal({ kind: "offer", sdp: "v=0" }, null),
    { type: "signal", data: { kind: "offer", sdp: "v=0" } },
    signal({ kind: "offer" }),
    signal({ kind: "answer", sdp: 1 }),
    signal({ kind: "bye", sdp: "v=0" }),
    signal(null),
    signal({ kind: "candidate" }),
    signal({ kind: "candidate", candidate: "candidate:1" }),
    signal({ kind: "candidate", candidate: { candidate: 1 } }),
    signal({ kind: "candidate", candidate: { candidate: "", sdpMid: 0 } }),
    signal({ kind: "candidate", candidate: { candidate: "", sdpMLineIndex: -1 } }),
    signal({ kind: "candidate", candidate: { candidate: "", sdpMLineIndex: 0.5 } }),
    signal({ kind: "candidate", candidate: { candidate: "", sdpMLineIndex: "0" } }),
  ]) {
    expect(parse(message)).toBeNull();
  }
});

test("hostName trims and bounds names and rejects control characters", () => {
  expect(hostName(" box ")).toBe("box");
  expect(hostName("💻".repeat(MAX_NAME_LENGTH / 2))).toBe("💻".repeat(MAX_NAME_LENGTH / 2));
  expect(hostName(`${"💻".repeat(MAX_NAME_LENGTH / 2)}a`)).toBeNull();
  expect(hostName("a".repeat(MAX_NAME_LENGTH + 1))).toBeNull();
  expect(hostName("   ")).toBeNull();
  expect(hostName("")).toBeNull();
  expect(hostName(42)).toBeNull();
  expect(hostName("a\nb")).toBeNull();
  expect(hostName("a\u0000b")).toBeNull();
  expect(hostName("a\u009bb")).toBeNull();
  expect(hostName("evil‮koob")).toBeNull();
});
