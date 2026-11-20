import type { ServerMessage } from "@gitui/shared";
import { expect, test } from "bun:test";
import { Rendezvous, rendezvousUrl, type SocketLike } from "./rendezvous.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(message: ServerMessage | string) {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  drop() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const client = new Rendezvous({
    url: "ws://test/v1/connect",
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoff: (attempt) => (delays.push(attempt), 0),
    linger: 0,
  });
  return { client, sockets, delays };
}

const wait = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const host = { id: "h1", name: "Jan's MacBook" };

test("rendezvousUrl puts the protocol path on the origin", () => {
  expect(rendezvousUrl("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/v1/connect");
  expect(rendezvousUrl()).toBe("wss://rendezvous.gitui.diffiii.dev/v1/connect");
});

test("says hello as a guest and publishes the hosts", () => {
  const { client, sockets } = setup();
  const seen: unknown[] = [];
  client.subscribe(() => seen.push(client.getSnapshot()));
  expect(client.getSnapshot()).toEqual({ status: "connecting", hosts: [] });

  sockets[0]!.open();
  expect(sockets[0]!.sent).toEqual([{ type: "hello", role: "guest" }]);
  sockets[0]!.receive({ type: "welcome", id: "g1" });
  sockets[0]!.receive({ type: "hosts", hosts: [host] });
  expect(seen).toEqual([
    { status: "open", hosts: [] },
    { status: "open", hosts: [host] },
  ]);
});

test("relays signals to and from a peer, and tells it when it's gone", () => {
  const { client, sockets } = setup();
  const got: unknown[] = [];
  const stop = client.listen("h1", { signal: (d) => got.push(d), gone: () => got.push("gone") });
  sockets[0]!.open();
  expect(client.signal("h1", { kind: "offer", sdp: "o" })).toBe(true);
  expect(sockets[0]!.sent.at(-1)).toEqual({
    type: "signal",
    to: "h1",
    data: { kind: "offer", sdp: "o" },
  });

  sockets[0]!.receive({ type: "signal", from: "h1", data: { kind: "answer", sdp: "a" } });
  sockets[0]!.receive({ type: "signal", from: "other", data: { kind: "answer", sdp: "x" } });
  sockets[0]!.receive({ type: "gone", id: "h1" });
  sockets[0]!.receive("garbage");
  expect(got).toEqual([{ kind: "answer", sdp: "a" }, "gone"]);

  stop();
  sockets[0]!.receive({ type: "signal", from: "h1", data: { kind: "answer", sdp: "b" } });
  expect(got).toHaveLength(2);
});

test("signal reports a signal it couldn't send", () => {
  const { client } = setup();
  client.subscribe(() => {});
  expect(client.signal("h1", { kind: "offer", sdp: "o" })).toBe(false);
});

test("reconnects with growing backoff and resets it once welcomed", async () => {
  const { client, sockets, delays } = setup();
  const gone: string[] = [];
  client.subscribe(() => {});
  client.listen("h1", { signal: () => {}, gone: () => gone.push("h1") });
  sockets[0]!.open();
  sockets[0]!.receive({ type: "hosts", hosts: [host] });

  sockets[0]!.drop();
  expect(client.getSnapshot()).toEqual({ status: "retrying", hosts: [] });
  expect(gone).toEqual(["h1"]);
  await wait();
  sockets[1]!.drop();
  await wait();
  expect(delays).toEqual([1, 2]);

  sockets[2]!.open();
  sockets[2]!.receive({ type: "welcome", id: "g2" });
  sockets[2]!.drop();
  await wait();
  expect(delays).toEqual([1, 2, 1]);
  expect(sockets).toHaveLength(4);
});

test("closes the socket once the last subscriber leaves, and reopens for the next", async () => {
  const { client, sockets } = setup();
  const stop = client.subscribe(() => {});
  sockets[0]!.open();
  sockets[0]!.receive({ type: "hosts", hosts: [host] });

  // A subscriber that comes back within the linger keeps the socket (React remounts).
  stop();
  const stopAgain = client.subscribe(() => {});
  await wait();
  expect(sockets[0]!.closed).toBe(false);

  stopAgain();
  await wait();
  expect(sockets[0]!.closed).toBe(true);
  expect(client.getSnapshot()).toEqual({ status: "connecting", hosts: [] });

  client.subscribe(() => {});
  expect(sockets).toHaveLength(2);
});
