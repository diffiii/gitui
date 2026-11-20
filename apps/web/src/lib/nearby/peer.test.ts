import type { HostInfo, SignalData } from "@gitui/shared";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectToHost, RefusedError, refusalMessage } from "./peer.ts";
import type { Rendezvous, SignalHandlers } from "./rendezvous.ts";

const host: HostInfo = { id: "peer-1", name: "MacBook", key: "k".repeat(16) };
const fingerprint = (byte: string) =>
  `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => byte).join(":")}`;
const sdp = (byte: string) => `v=0\r\n${fingerprint(byte)}\r\n`;

/** The parts of RTCPeerConnection connectToHost uses; the test opens its channel. */
class FakePeerConnection {
  static last: FakePeerConnection;
  localDescription: { sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  connectionState = "new";
  readonly candidates: unknown[] = [];
  readonly channel = {
    readyState: "connecting",
    binaryType: "",
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onopen: null as (() => void) | null,
    onmessage: null,
    onclose: null,
    send() {},
    addEventListener() {},
  };
  onicecandidate = null;
  onconnectionstatechange = null;
  constructor() {
    FakePeerConnection.last = this;
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: sdp("aa") };
  }
  async setLocalDescription(description: { sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: { sdp: string }) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
  }
  close() {
    this.connectionState = "closed";
  }
}

/** A rendezvous that records the signals sent and lets the test send the host's. */
function fakeRendezvous() {
  const sent: SignalData[] = [];
  let handlers: SignalHandlers | null = null;
  const rendezvous = {
    listen: (_peer: string, h: SignalHandlers) => {
      handlers = h;
      return () => void (handlers = null);
    },
    signal: (_to: string, data: SignalData) => (sent.push(data), true),
  } as unknown as Rendezvous;
  return {
    rendezvous,
    sent,
    receive: (data: SignalData) => handlers?.signal(data),
    listening: () => handlers !== null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const STALE = "s".repeat(16);

let saved: unknown;
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).RTCPeerConnection;
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
});
afterAll(() => {
  (globalThis as Record<string, unknown>).RTCPeerConnection = saved;
});

test("signals of another offer are dropped; the current offer's are used", async () => {
  const r = fakeRendezvous();
  const connecting = connectToHost(r.rendezvous, host, { timeout: 1000, answerTimeout: 1000 });
  await flush();
  const offer = r.sent[0]!;
  expect(offer).toMatchObject({ kind: "offer" });
  const { offerId } = offer;
  const pc = FakePeerConnection.last;

  r.receive({ kind: "refused", offerId: STALE, reason: "busy" });
  r.receive({ kind: "answer", offerId: STALE, sdp: sdp("cc") });
  r.receive({ kind: "candidate", offerId: STALE, candidate: { candidate: "stale" } });
  await flush();
  expect(pc.remoteDescription).toBeNull();

  r.receive({ kind: "answer", offerId, sdp: sdp("bb") });
  r.receive({ kind: "candidate", offerId, candidate: { candidate: "current" } });
  r.receive({ kind: "candidate", offerId: STALE, candidate: { candidate: "stale" } });
  await flush();
  expect(pc.remoteDescription).toEqual({ type: "answer", sdp: sdp("bb") } as never);
  expect(pc.candidates).toEqual([{ candidate: "current" }]);

  pc.channel.readyState = "open";
  pc.channel.onopen!();
  const peer = await connecting;
  expect(r.listening()).toBe(false); // signaling is over
  peer.close();
});

for (const reason of ["busy", "rate-limited"] as const) {
  test(`the current offer's refusal (${reason}) fails with a RefusedError`, async () => {
    const r = fakeRendezvous();
    const connecting = connectToHost(r.rendezvous, host, { timeout: 1000, answerTimeout: 1000 });
    await flush();
    r.receive({ kind: "refused", offerId: r.sent[0]!.offerId, reason });
    const error = await connecting.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RefusedError);
    expect((error as Error).message).toContain("MacBook");
    expect(FakePeerConnection.last.connectionState).toBe("closed");
    expect(r.listening()).toBe(false);
  });
}

test("each refusal reason has its own message", () => {
  expect(refusalMessage("MacBook", "busy")).toContain("busy");
  expect(refusalMessage("MacBook", "pairing-locked")).toContain("10 minutes");
  expect(refusalMessage("MacBook", "unknown")).toBe(
    "MacBook refused the connection. Try again, or reload this page.",
  );
});
