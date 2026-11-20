import { CHUNK_SIZE, frameChunk, parseChunk, type ChannelMessage } from "@gitui/shared";
import { expect, test } from "bun:test";
import {
  ChannelClosedError,
  ChannelRequestError,
  createChannelClient,
  decodeIncoming,
  SEND_HIGH_WATER,
  type ChannelTransport,
} from "./channelFetch.ts";

/** Records what the client sends; `buffered` and `drain()` play the send buffer. */
function fakeTransport() {
  const sent: (string | Uint8Array)[] = [];
  let release = () => {};
  const transport = {
    sent,
    bufferedAmount: 0,
    send: (data: string | Uint8Array) => void sent.push(data),
    drained: () => new Promise<void>((resolve) => (release = resolve)),
    drain() {
      transport.bufferedAmount = 0;
      release();
    },
  } satisfies ChannelTransport & Record<string, unknown>;
  return transport;
}

const text = (m: ChannelMessage) => JSON.stringify(m);
const bytes = (s: string) => new TextEncoder().encode(s);
const frame = (id: number, s: string) => frameChunk(id, bytes(s));
const messages = (sent: (string | Uint8Array)[]) =>
  sent.map((m) => (typeof m === "string" ? JSON.parse(m) : { frame: parseChunk(m).id }));
/** What `promise` rejected with; fails the test if it resolved. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable("resolved"),
    (e: unknown) => e,
  );
/** Lets the client's async send loop run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a request goes out as its head, its body in frames and end", async () => {
  const transport = fakeTransport();
  const client = createChannelClient(transport);
  void client.fetch("/api/open?x=1", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gitui": "1" },
    body: "a".repeat(CHUNK_SIZE + 10),
  });
  await tick();
  expect(messages(transport.sent)).toEqual([
    {
      t: "req",
      id: 1,
      method: "POST",
      path: "/api/open?x=1",
      headers: [
        ["content-type", "application/json"],
        ["x-gitui", "1"],
      ],
    },
    { frame: 1 },
    { frame: 1 },
    { t: "end", id: 1 },
  ]);
  const second = transport.sent[2] as Uint8Array;
  expect(parseChunk(second).payload.byteLength).toBe(10);
});

test("concurrent requests get increasing ids and their interleaved answers", async () => {
  const transport = fakeTransport();
  const client = createChannelClient(transport);
  const a = client.fetch("/a");
  const b = client.fetch("/b");
  await tick();
  expect(
    messages(transport.sent)
      .filter((m) => m.t === "req")
      .map((m) => m.id),
  ).toEqual([1, 2]);

  client.receive(text({ t: "res", id: 2, status: 404, headers: [["x-b", "b"]] }));
  client.receive(text({ t: "res", id: 1, status: 200, headers: [["content-type", "text/plain"]] }));
  client.receive(frame(1, "hel"));
  client.receive(frame(2, "nope"));
  client.receive(frame(1, "lo").buffer as ArrayBuffer);
  client.receive(text({ t: "end", id: 2 }));
  client.receive(text({ t: "end", id: 1 }));

  const [ra, rb] = await Promise.all([a, b]);
  expect([ra.status, ra.headers.get("content-type"), await ra.text()]).toEqual([
    200,
    "text/plain",
    "hello",
  ]);
  expect([rb.status, rb.headers.get("x-b"), await rb.text()]).toEqual([404, "b", "nope"]);
});

test("a multi-chunk response body is reassembled in order", async () => {
  const client = createChannelClient(fakeTransport());
  const body = new Uint8Array(CHUNK_SIZE * 3 + 7).map((_, i) => i % 251);
  const res = client.fetch("/big");
  client.receive(text({ t: "res", id: 1, status: 200, headers: [] }));
  for (let at = 0; at < body.byteLength; at += CHUNK_SIZE) {
    client.receive(frameChunk(1, body.subarray(at, at + CHUNK_SIZE)));
  }
  client.receive(text({ t: "end", id: 1 }));
  expect(new Uint8Array(await (await res).arrayBuffer())).toEqual(body);
});

test("a response with a null-body status has no body", async () => {
  const client = createChannelClient(fakeTransport());
  const res = client.fetch("/x");
  client.receive(text({ t: "res", id: 1, status: 204, headers: [] }));
  client.receive(text({ t: "end", id: 1 }));
  expect((await res).body).toBeNull();
});

test("abort rejects only its own request", async () => {
  const client = createChannelClient(fakeTransport());
  const a = client.fetch("/a");
  const b = client.fetch("/b");
  client.receive(text({ t: "res", id: 1, status: 200, headers: [] }));
  client.receive(text({ t: "abort", id: 1, message: "the app threw" }));
  client.receive(text({ t: "res", id: 2, status: 200, headers: [] }));
  client.receive(text({ t: "end", id: 2 }));
  expect(await rejection(a)).toEqual(new ChannelRequestError("the app threw"));
  expect((await b).status).toBe(200);
});

test("unknown ids and garbage are reported and dropped", async () => {
  const errors: string[] = [];
  const client = createChannelClient(fakeTransport(), (e) => errors.push(e));
  const res = client.fetch("/a");
  client.receive(text({ t: "res", id: 9, status: 200, headers: [] }));
  client.receive(frame(9, "x"));
  client.receive(text({ t: "end", id: 9 }));
  client.receive("not json");
  client.receive("[1]");
  client.receive(JSON.stringify({ t: "res", id: 1, status: "200", headers: [] }));
  client.receive(text({ t: "auth-ok" }));
  client.receive(new Uint8Array([0, 0]));
  expect(errors).toEqual([
    "res for unknown request 9",
    "frame for unknown request 9",
    "end for unknown request 9",
    "message isn't JSON",
    "message isn't an object",
    'unexpected message {"t":"res","id":1,"status":"200","headers":[]}',
    "unexpected auth-ok message",
    "frame shorter than its header",
  ]);
  // The request in flight is unaffected.
  client.receive(text({ t: "res", id: 1, status: 200, headers: [] }));
  client.receive(text({ t: "end", id: 1 }));
  expect((await res).status).toBe(200);
});

test("protocol violations fail the request they concern", async () => {
  const client = createChannelClient(fakeTransport());
  const early = client.fetch("/a");
  client.receive(frame(1, "x"));
  expect(await rejection(early)).toEqual(
    new ChannelRequestError("body frame before the response head"),
  );
  const endFirst = client.fetch("/b");
  client.receive(text({ t: "end", id: 2 }));
  expect(await rejection(endFirst)).toEqual(
    new ChannelRequestError("end before the response head"),
  );
});

test("a caller's abort signal stops the wait, and later answers are dropped", async () => {
  const errors: string[] = [];
  const client = createChannelClient(fakeTransport(), (e) => errors.push(e));
  const controller = new AbortController();
  const res = client.fetch("/slow", { signal: controller.signal });
  controller.abort();
  expect(await rejection(res)).toMatchObject({ name: "AbortError" });
  client.receive(text({ t: "res", id: 1, status: 200, headers: [] }));
  expect(errors).toEqual(["res for unknown request 1"]);
});

test("close fails requests in flight and later ones", async () => {
  const client = createChannelClient(fakeTransport());
  const res = client.fetch("/a");
  client.close("channel closed");
  expect(await rejection(res)).toEqual(new ChannelClosedError("channel closed"));
  expect(await rejection(client.fetch("/b"))).toBeInstanceOf(ChannelClosedError);
});

test("sending waits while the transport's buffer is above the high-water mark", async () => {
  const transport = fakeTransport();
  const client = createChannelClient(transport);
  transport.bufferedAmount = SEND_HIGH_WATER + 1;
  void client.fetch("/up", { method: "POST", body: "x" });
  await tick();
  expect(transport.sent).toEqual([]);
  transport.drain();
  await tick();
  expect(messages(transport.sent).map((m) => m.t ?? "frame")).toEqual(["req", "frame", "end"]);
});

test("decodeIncoming accepts only what a host may send", () => {
  expect(decodeIncoming(text({ t: "auth-fail", attemptsLeft: 2 }))).toEqual({
    kind: "message",
    message: { t: "auth-fail", attemptsLeft: 2 },
  });
  expect(decodeIncoming(text({ t: "auth", proof: "p" })).kind).toBe("invalid");
  expect(
    decodeIncoming(JSON.stringify({ t: "res", id: 1, status: 200, headers: [["a"]] })).kind,
  ).toBe("invalid");
});
