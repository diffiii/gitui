import { afterEach, expect, test } from "bun:test";
import type { ClientMessage } from "@gitui/shared";
import { fakeSockets } from "./fake-socket.ts";
import { startScoped } from "../test-scope.ts";
import {
  backoffDelay,
  rendezvousClient,
  type RendezvousEvents,
  type RendezvousOptions,
} from "./rendezvous.ts";

test("backoff doubles up to the cap, with jitter", () => {
  const backoff = { first: 100, max: 1000 };
  for (let attempt = 0; attempt < 8; attempt++) {
    const delay = backoffDelay(attempt, backoff);
    const full = Math.min(1000, 100 * 2 ** attempt);
    expect(delay).toBeGreaterThanOrEqual(full / 2);
    expect(delay).toBeLessThanOrEqual(full);
  }
});

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
};

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const SECRET = "s".repeat(43);
const hello: ClientMessage = { type: "hello", role: "host", name: "Desk", secret: SECRET };

/** A client on fake sockets, logging its events. */
function client(options: Partial<RendezvousOptions> = {}) {
  const fake = fakeSockets();
  const log: string[] = [];
  const events: RendezvousEvents = {
    welcome: (id) => log.push(`welcome ${id}`),
    down: () => log.push("down"),
    signal: (from, data) => log.push(`signal ${from} ${data.kind}`),
    gone: (id) => log.push(`gone ${id}`),
    error: (code, message) => log.push(`error ${code} ${message}`),
  };
  const rendezvous = startScoped(
    rendezvousClient({
      url: "wss://rendezvous.example/v1/connect",
      family: 6,
      name: "Desk",
      secret: SECRET,
      events,
      open: fake.open,
      backoff: { first: 10, max: 20 },
      ...options,
    }),
  );
  cleanup.push(() => rendezvous.stop());
  return { rendezvous, log, ...fake };
}

test("the client says hello with its secret, relays signals both ways and reconnects", async () => {
  const { rendezvous, log, sockets } = client();
  expect(sockets).toHaveLength(1);
  const [socket] = sockets;
  expect(socket.url).toBe("wss://rendezvous.example/v1/connect");
  expect(socket.family).toBe(6);
  socket.open();
  expect(socket.sent).toEqual([hello]);

  socket.receive({ type: "welcome", id: "h1" });
  socket.receive("pong");
  socket.receive({ type: "pong" });
  socket.receive({ type: "hosts", hosts: [] });
  socket.receive({
    type: "signal",
    from: "g1",
    data: { kind: "offer", offerId: "offer-0123456789ab", sdp: "v=0" },
  });
  socket.receive({ type: "gone", id: "g1" });
  socket.receive({ type: "error", code: "unknown-peer", message: "Unknown peer" });
  socket.emit("message", Buffer.from('{"type":"gone","id":"g2"}'), true);
  expect(log).toEqual([
    "welcome h1",
    "signal g1 offer",
    "gone g1",
    "error unknown-peer Unknown peer",
  ]);

  rendezvous.send("g1", { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" });
  expect(socket.sent[1]).toEqual({
    type: "signal",
    to: "g1",
    data: { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" },
  });

  socket.fail();
  expect(log.at(-1)).toBe("down");
  await until(() => sockets.length === 2);
  sockets[1].open();
  expect(sockets[1].sent).toEqual([hello]);
  // Signals go out on the live socket only.
  rendezvous.send("g1", { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" });
  expect(socket.sent).toHaveLength(2);
  expect(sockets[1].sent).toHaveLength(2);
});

test("the client pings; a socket without a pong is dropped and replaced", async () => {
  const { log, sockets } = client({ keepalive: { interval: 30, timeout: 20 } });
  const [socket] = sockets;
  socket.open();
  socket.receive({ type: "welcome", id: "h1" });

  // Answered pings keep the socket.
  for (let n = 1; n <= 3; n++) {
    await until(() => socket.pings === n);
    socket.emit("pong");
  }
  expect(socket.terminated).toBe(false);

  // An unanswered one ends it.
  await until(() => socket.terminated);
  expect(socket.pings).toBe(4);
  expect(log).toEqual(["welcome h1", "down"]);
  await until(() => sockets.length === 2);
  sockets[1].open();
  expect(sockets[1].sent).toEqual([hello]);
});

test("an unreachable service is retried until it answers", async () => {
  const { log, sockets } = client();
  for (let n = 1; n <= 3; n++) {
    await until(() => sockets.length === n);
    sockets[n - 1].fail();
  }
  expect(log).toEqual(["down", "down", "down"]);
  await until(() => sockets.length === 4);
  sockets[3].open();
  sockets[3].receive({ type: "welcome", id: "h9" });
  expect(log.at(-1)).toBe("welcome h9");
});

test("stopping closes the socket and reconnects no more", async () => {
  const { rendezvous, log, sockets } = client();
  sockets[0].open();
  await rendezvous.stop();
  await new Promise((r) => setTimeout(r, 50));
  expect(sockets).toHaveLength(1);
  expect(log).toEqual([]);
});

test("over a real WebSocket: hello with the secret, protocol pings, IPv4 and IPv6", async () => {
  const pings: string[] = [];
  const hellos: string[] = [];
  const serve = (hostname: string, port = 0) =>
    Bun.serve({
      hostname,
      port,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message: (ws, message) => void hellos.push(`${ws.remoteAddress} ${String(message)}`),
        ping: (ws) => void pings.push(ws.remoteAddress),
      },
    });
  const v4 = serve("127.0.0.1");
  const v6 = serve("::1", v4.port);
  cleanup.push(
    () => void v4.stop(true),
    () => void v6.stop(true),
  );
  for (const family of [4, 6] as const) {
    const rendezvous = startScoped(
      rendezvousClient({
        url: `ws://localhost:${v4.port}`,
        family,
        name: "Desk",
        secret: SECRET,
        keepalive: { interval: 20, timeout: 1000 },
        events: {
          welcome() {},
          down() {},
          signal() {},
          gone() {},
          error() {},
        },
      }),
    );
    cleanup.push(() => rendezvous.stop());
  }
  await until(() => hellos.length === 2 && new Set(pings).size === 2);
  expect(hellos.toSorted()).toEqual([
    `127.0.0.1 ${JSON.stringify(hello)}`,
    `::1 ${JSON.stringify(hello)}`,
  ]);
});
