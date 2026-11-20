import { afterEach, expect, test } from "bun:test";
import type { ClientMessage, SignalData } from "@gitui/shared";
import {
  backoffDelay,
  parseServerMessage,
  parseSignal,
  PING,
  RendezvousClient,
  type RendezvousEvents,
} from "./rendezvous.ts";

test("server messages a host handles are parsed; anything else is null", () => {
  const offer: SignalData = { kind: "offer", sdp: "v=0" };
  expect(parseServerMessage('{"type":"welcome","id":"h1"}')).toEqual({ type: "welcome", id: "h1" });
  expect(parseServerMessage('{"type":"gone","id":"g1"}')).toEqual({ type: "gone", id: "g1" });
  expect(parseServerMessage(JSON.stringify({ type: "signal", from: "g1", data: offer }))).toEqual({
    type: "signal",
    from: "g1",
    data: offer,
  });
  expect(parseServerMessage('{"type":"error","message":"bad hello"}')).toEqual({
    type: "error",
    message: "bad hello",
  });
  for (const text of [
    "pong",
    "null",
    "[]",
    '{"type":"hosts","hosts":[]}',
    '{"type":"welcome"}',
    '{"type":"signal","from":"g1","data":{"kind":"offer"}}',
    JSON.stringify({ type: "signal", data: offer }),
  ]) {
    expect(parseServerMessage(text)).toBeNull();
  }
});

test("signals are checked field by field", () => {
  const candidate = { candidate: "candidate:1 1 udp 1 10.0.0.1 9 typ host", sdpMid: "0" };
  expect(parseSignal({ kind: "candidate", candidate })).toEqual({ kind: "candidate", candidate });
  expect(
    parseSignal({ kind: "candidate", candidate: { candidate: "c", sdpMLineIndex: null } }),
  ).toEqual({ kind: "candidate", candidate: { candidate: "c", sdpMLineIndex: null } });
  for (const bad of [
    { kind: "candidate", candidate: { candidate: 1 } },
    { kind: "candidate", candidate: { candidate: "c", sdpMid: 0 } },
    { kind: "candidate", candidate: { candidate: "c", sdpMLineIndex: "0" } },
    { kind: "offer", sdp: "x".repeat(64 * 1024 + 1) },
    { kind: "renegotiate", sdp: "v=0" },
  ]) {
    expect(parseSignal(bad)).toBeNull();
  }
});

test("backoff doubles up to the cap, with jitter", () => {
  const backoff = { first: 100, max: 1000 };
  for (let attempt = 0; attempt < 8; attempt++) {
    const delay = backoffDelay(attempt, backoff);
    const full = Math.min(1000, 100 * 2 ** attempt);
    expect(delay).toBeGreaterThanOrEqual(full / 2);
    expect(delay).toBeLessThanOrEqual(full);
  }
});

/** A rendezvous stand-in that records what hosts send and lets the test answer. */
function fakeService() {
  const received: (ClientMessage | string)[] = [];
  const sockets: Bun.ServerWebSocket[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => void sockets.push(ws),
      message: (_ws, message) => {
        const text = String(message);
        received.push(text === PING ? text : (JSON.parse(text) as ClientMessage));
      },
    },
  });
  return { url: `ws://localhost:${server.port}`, server, received, sockets };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

test("the client says hello as a host, relays signals both ways and reconnects", async () => {
  const service = fakeService();
  const log: string[] = [];
  const events: RendezvousEvents = {
    welcome: (id) => log.push(`welcome ${id}`),
    down: () => log.push("down"),
    signal: (from, data) => log.push(`signal ${from} ${data.kind}`),
    gone: (id) => log.push(`gone ${id}`),
    error: (message) => log.push(`error ${message}`),
  };
  const client = new RendezvousClient(service.url, "Desk", events, { first: 10, max: 20 });
  cleanup.push(
    () => client.stop(),
    () => service.server.stop(true),
  );
  client.start();

  await until(() => service.received.length === 1);
  expect(service.received[0]).toEqual({ type: "hello", role: "host", name: "Desk" });

  const [socket] = service.sockets;
  socket.send(JSON.stringify({ type: "welcome", id: "h1" }));
  socket.send("pong");
  socket.send(JSON.stringify({ type: "hosts", hosts: [] }));
  socket.send(JSON.stringify({ type: "signal", from: "g1", data: { kind: "offer", sdp: "v=0" } }));
  socket.send(JSON.stringify({ type: "gone", id: "g1" }));
  socket.send(JSON.stringify({ type: "error", message: "slow down" }));
  await until(() => log.length === 4);
  expect(log).toEqual(["welcome h1", "signal g1 offer", "gone g1", "error slow down"]);

  client.send("g1", { kind: "answer", sdp: "v=0" });
  await until(() => service.received.length === 2);
  expect(service.received[1]).toEqual({
    type: "signal",
    to: "g1",
    data: { kind: "answer", sdp: "v=0" },
  });

  socket.close();
  await until(() => service.sockets.length === 2 && service.received.length === 3);
  expect(log.at(-1)).toBe("down");
  expect(service.received[2]).toEqual({ type: "hello", role: "host", name: "Desk" });
});

test("an unreachable service is retried until it answers", async () => {
  const service = fakeService();
  const { port } = service.server;
  await service.server.stop(true);
  let downs = 0;
  const client = new RendezvousClient(
    `ws://localhost:${port}`,
    "Desk",
    { welcome() {}, down: () => void downs++, signal() {}, gone() {}, error() {} },
    { first: 10, max: 20 },
  );
  cleanup.push(() => client.stop());
  client.start();
  await until(() => downs >= 2);
});
