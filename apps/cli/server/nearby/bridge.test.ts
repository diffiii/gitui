import { expect, test } from "bun:test";
import { CHUNK_SIZE, type ChannelMessage, chunks, frameChunk, parseChunk } from "@gitui/shared";
import { createApp } from "../app.ts";
import {
  Bridge,
  type BridgeChannel,
  decode,
  type Fetch,
  HIGH_WATER,
  LOW_WATER,
  MAX_OPEN_REQUESTS,
  MAX_REQUEST_BODY,
} from "./bridge.ts";

/** A channel that keeps what is sent and drains only when told to. */
class FakeChannel implements BridgeChannel {
  sent: (string | Uint8Array)[] = [];
  bufferedAmount = 0;
  maxBuffered = 0;
  closed = false;
  #waiters: { threshold: number; resolve: () => void }[] = [];

  send(data: string | Uint8Array) {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
    this.bufferedAmount += typeof data === "string" ? data.length : data.byteLength;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
  }

  drain(threshold: number) {
    if (this.closed || this.bufferedAmount <= threshold) return Promise.resolve();
    return new Promise<void>((resolve) => this.#waiters.push({ threshold, resolve }));
  }

  /** The network sends everything queued. */
  flush() {
    this.bufferedAmount = 0;
    for (const { resolve } of this.#waiters.splice(0)) resolve();
  }

  close() {
    this.closed = true;
    for (const { resolve } of this.#waiters.splice(0)) resolve();
  }
}

interface Reply {
  head?: Extract<ChannelMessage, { t: "res" }>;
  body: Uint8Array[];
  ended: boolean;
  aborted?: string;
}

/** What the guest received, by request id. */
function replies(channel: FakeChannel) {
  const byId = new Map<number, Reply>();
  const reply = (id: number) => {
    if (!byId.has(id)) byId.set(id, { body: [], ended: false });
    return byId.get(id)!;
  };
  for (const data of channel.sent) {
    if (typeof data !== "string") {
      expect(data.byteLength).toBeLessThanOrEqual(4 + CHUNK_SIZE);
      const { id, payload } = parseChunk(data);
      const r = reply(id);
      expect(r.head).toBeDefined();
      expect(r.ended).toBe(false);
      r.body.push(payload);
      continue;
    }
    const message = JSON.parse(data) as ChannelMessage;
    if (message.t === "res") reply(message.id).head = message;
    else if (message.t === "end") reply(message.id).ended = true;
    else if (message.t === "abort") reply(message.id).aborted = message.message;
  }
  return byId;
}

const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString();
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Sends a whole request the way a guest does. */
function request(
  bridge: Bridge,
  id: number,
  path: string,
  init: { method?: string; headers?: [string, string][]; body?: Uint8Array } = {},
) {
  const { method = "GET", headers = [], body } = init;
  bridge.receive(JSON.stringify({ t: "req", id, method, path, headers }));
  for (const piece of body ? chunks(body) : []) bridge.receive(frameChunk(id, piece));
  bridge.receive(JSON.stringify({ t: "end", id }));
}

/** An app that echoes the request back as JSON, or returns `size` bytes for /big/<size>. */
const echo: Fetch = async (req) => {
  const url = new URL(req.url);
  const big = /^\/big\/(\d+)$/.exec(url.pathname);
  if (big) return new Response(new Uint8Array(Number(big[1])).fill(120));
  return Response.json({
    method: req.method,
    url: req.url,
    host: req.headers.get("host"),
    custom: req.headers.get("x-custom"),
    body: await req.text(),
  });
};

test("a GET is rebuilt for the nearby host, with its headers, and answered", async () => {
  const channel = new FakeChannel();
  request(new Bridge(channel, echo), 1, "/api/config?x=1", { headers: [["x-custom", "yes"]] });
  await settle();
  const reply = replies(channel).get(1)!;
  expect(reply.head?.status).toBe(200);
  expect(reply.head?.headers).toContainEqual(["content-type", "application/json;charset=utf-8"]);
  expect(reply.ended).toBe(true);
  expect(JSON.parse(text(reply.body))).toEqual({
    method: "GET",
    url: "http://nearby.invalid/api/config?x=1",
    host: "nearby.invalid",
    custom: "yes",
    body: "",
  });
});

test("a body split into many frames is reassembled", async () => {
  const channel = new FakeChannel();
  const body = Buffer.from("x".repeat(5 * CHUNK_SIZE + 123));
  request(new Bridge(channel, echo), 7, "/api/stage", { method: "POST", body });
  await settle();
  const reply = replies(channel).get(7)!;
  expect(JSON.parse(text(reply.body))).toMatchObject({ method: "POST", body: body.toString() });
});

test("a large response goes out in CHUNK_SIZE frames, waiting for the channel to drain", async () => {
  const channel = new FakeChannel();
  const size = 5 * HIGH_WATER + 17;
  request(new Bridge(channel, echo), 3, `/big/${size}`);
  await settle();
  // The response stops at the high-water mark until the channel drains.
  expect(channel.bufferedAmount).toBeGreaterThan(HIGH_WATER);
  expect(channel.maxBuffered).toBeLessThanOrEqual(HIGH_WATER + 4 + CHUNK_SIZE);
  expect(replies(channel).get(3)!.ended).toBe(false);
  while (!replies(channel).get(3)!.ended) {
    channel.flush();
    await settle();
  }
  expect(channel.maxBuffered).toBeLessThanOrEqual(HIGH_WATER + 4 + CHUNK_SIZE);
  const reply = replies(channel).get(3)!;
  expect(reply.body.length).toBe(Math.ceil(size / CHUNK_SIZE));
  expect(Buffer.concat(reply.body)).toEqual(Buffer.alloc(size, 120));
  expect(LOW_WATER).toBeLessThan(HIGH_WATER);
});

test("interleaved requests are kept apart and answered as each completes", async () => {
  const channel = new FakeChannel();
  const bridge = new Bridge(channel, echo);
  const a = Buffer.from("a".repeat(CHUNK_SIZE * 2));
  const b = Buffer.from("b".repeat(CHUNK_SIZE + 1));
  const head = (id: number) =>
    JSON.stringify({ t: "req", id, method: "POST", path: `/api/${id}`, headers: [] });
  bridge.receive(head(1));
  bridge.receive(head(2));
  const [a1, a2] = chunks(a);
  const [b1, b2] = chunks(b);
  for (const frame of [frameChunk(2, b1), frameChunk(1, a1), frameChunk(2, b2)]) {
    bridge.receive(frame);
  }
  bridge.receive(JSON.stringify({ t: "end", id: 2 }));
  bridge.receive(frameChunk(1, a2));
  bridge.receive(JSON.stringify({ t: "end", id: 1 }));
  await settle();
  const all = replies(channel);
  expect(JSON.parse(text(all.get(1)!.body)).body).toBe(a.toString());
  expect(JSON.parse(text(all.get(2)!.body)).body).toBe(b.toString());
});

test("responses stream concurrently, interleaving their frames", async () => {
  const channel = new FakeChannel();
  const bridge = new Bridge(channel, echo);
  const size = 3 * HIGH_WATER;
  request(bridge, 1, `/big/${size}`);
  request(bridge, 2, `/big/${size}`);
  const done = () => [1, 2].every((id) => replies(channel).get(id)?.ended);
  for (let i = 0; i < 20 && !done(); i++) {
    channel.flush();
    await settle();
  }
  const ids = channel.sent.filter((d) => typeof d !== "string").map((d) => parseChunk(d).id);
  expect(ids.indexOf(2)).toBeLessThan(ids.lastIndexOf(1));
  expect(done()).toBe(true);
  for (const id of [1, 2]) expect(Buffer.concat(replies(channel).get(id)!.body).length).toBe(size);
});

test("an app that throws, or a body that fails midway, aborts the request", async () => {
  const channel = new FakeChannel();
  const bridge = new Bridge(channel, (req) => {
    if (req.url.endsWith("/throw")) throw new Error("boom");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new Error("disk gone"));
      },
    });
    return new Response(body);
  });
  request(bridge, 1, "/throw");
  request(bridge, 2, "/midway");
  await settle();
  const all = replies(channel);
  expect(all.get(1)).toEqual({ body: [], ended: false, aborted: "boom" });
  expect(all.get(2)!.head?.status).toBe(200);
  expect(all.get(2)!.aborted).toBe("disk gone");
  expect(all.get(2)!.ended).toBe(false);
});

test("the guest's abort stops a response and frees its id", async () => {
  const channel = new FakeChannel();
  let cancelled = false;
  const bridge = new Bridge(channel, () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(CHUNK_SIZE)),
      cancel: () => {
        cancelled = true;
      },
    });
    return new Response(body);
  });
  request(bridge, 1, "/forever");
  await settle();
  bridge.receive(JSON.stringify({ t: "abort", id: 1 }));
  channel.flush();
  await settle();
  expect(cancelled).toBe(true);
  const sent = channel.sent.length;
  channel.flush();
  await settle();
  expect(channel.sent.length).toBe(sent);
  expect(replies(channel).get(1)!.ended).toBe(false);
  expect(replies(channel).get(1)!.aborted).toBeUndefined();
});

test("an abort before the end drops the request unanswered", async () => {
  const channel = new FakeChannel();
  let calls = 0;
  const bridge = new Bridge(channel, () => {
    calls++;
    return new Response("");
  });
  bridge.receive(JSON.stringify({ t: "req", id: 4, method: "POST", path: "/x", headers: [] }));
  bridge.receive(frameChunk(4, new Uint8Array(3)));
  bridge.receive(JSON.stringify({ t: "abort", id: 4 }));
  bridge.receive(JSON.stringify({ t: "end", id: 4 }));
  await settle();
  expect(calls).toBe(0);
  expect(channel.sent).toEqual([]);
});

test("closing the bridge stops every response", async () => {
  const channel = new FakeChannel();
  const bridge = new Bridge(channel, echo);
  request(bridge, 1, `/big/${4 * HIGH_WATER}`);
  await settle();
  const sent = channel.sent.length;
  channel.close();
  bridge.close();
  await settle();
  expect(channel.sent.length).toBe(sent);
});

test("garbage is dropped, or aborts the request it names", async () => {
  const channel = new FakeChannel();
  let calls = 0;
  const bridge = new Bridge(channel, (req) => {
    calls++;
    return echo(req);
  });
  const head = (fields: object) =>
    JSON.stringify({ t: "req", id: 9, method: "GET", path: "/api", headers: [], ...fields });

  // Nothing to answer: no id, or a frame of no open request.
  for (const data of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ t: "req", id: -1, method: "GET", path: "/", headers: [] }),
    JSON.stringify({ t: "req", id: 2 ** 32, method: "GET", path: "/", headers: [] }),
    JSON.stringify({ t: "auth", proof: "x" }),
    new Uint8Array(3),
    frameChunk(77, new Uint8Array(5)),
    JSON.stringify({ t: "end", id: 77 }),
  ]) {
    bridge.receive(data);
  }
  await settle();
  expect(channel.sent).toEqual([]);

  const refused: [string | Uint8Array, string][] = [
    [head({ method: "G E T" }), "invalid method"],
    [head({ path: "api" }), "invalid path"],
    [head({ path: "//evil.example/api" }), "invalid path"],
    [head({ path: "http://evil.example/api" }), "invalid path"],
    [head({ headers: [["a"]] }), "invalid headers"],
    [head({ headers: { a: "b" } }), "invalid headers"],
    [JSON.stringify({ t: "res", id: 9, status: 200, headers: [] }), 'unexpected message "res"'],
  ];
  for (const [data, reason] of refused) {
    channel.sent = [];
    bridge.receive(data);
    expect(replies(channel).get(9)?.aborted).toBe(reason);
  }

  channel.sent = [];
  bridge.receive(head({ headers: [["bad name", "x"]] }));
  bridge.receive(JSON.stringify({ t: "end", id: 9 }));
  expect(replies(channel).get(9)?.aborted).toBeString();

  channel.sent = [];
  bridge.receive(head({}));
  bridge.receive(frameChunk(9, new Uint8Array(1)));
  bridge.receive(JSON.stringify({ t: "end", id: 9 }));
  expect(replies(channel).get(9)?.aborted).toBe("a GET request can't have a body");
  expect(calls).toBe(0);
});

test("an id in use, too many open requests and an oversized body are refused", async () => {
  const channel = new FakeChannel();
  const bridge = new Bridge(channel, echo);
  const head = (id: number) =>
    JSON.stringify({ t: "req", id, method: "POST", path: "/x", headers: [] });

  bridge.receive(head(1));
  bridge.receive(head(1));
  expect(replies(channel).get(1)?.aborted).toBe("request id already in use");

  channel.sent = [];
  for (let id = 100; id < 100 + MAX_OPEN_REQUESTS; id++) bridge.receive(head(id));
  expect(channel.sent).toEqual([]);
  bridge.receive(head(999));
  expect(replies(channel).get(999)?.aborted).toBe("too many open requests");

  channel.sent = [];
  const piece = new Uint8Array(CHUNK_SIZE);
  for (let sent = 0; sent <= MAX_REQUEST_BODY; sent += CHUNK_SIZE) {
    bridge.receive(frameChunk(100, piece));
  }
  expect(replies(channel).get(100)?.aborted).toBe("request body too large");
  bridge.receive(JSON.stringify({ t: "end", id: 100 }));
  await settle();
  expect(replies(channel).get(100)?.head).toBeUndefined();
});

test("decode reads frames and heads", () => {
  expect(decode(frameChunk(5, new Uint8Array([1, 2])))).toEqual({
    kind: "chunk",
    id: 5,
    payload: new Uint8Array([1, 2]),
  });
  expect(decode(JSON.stringify({ t: "end", id: 5 }))).toEqual({ kind: "end", id: 5 });
});

test("through the app, the nearby rules want x-gitui and no Origin; nothing else gets in", async () => {
  const app = createApp({ listener: { kind: "nearby" } });
  const channel = new FakeChannel();
  const bridge = new Bridge(channel, app.fetch);
  request(bridge, 1, "/api/config", { headers: [["x-gitui", "1"]] });
  request(bridge, 2, "/api/config");
  request(bridge, 3, "/api/config", {
    headers: [
      ["x-gitui", "1"],
      ["origin", "https://evil.example"],
    ],
  });
  // A guest can't pick the Host: the bridge sets it.
  request(bridge, 4, "/api/config", {
    headers: [
      ["x-gitui", "1"],
      ["host", "localhost"],
    ],
  });
  await settle();
  const all = replies(channel);
  expect(all.get(1)!.head?.status).toBe(200);
  expect(JSON.parse(text(all.get(1)!.body))).toHaveProperty("recent");
  expect(all.get(2)!.head?.status).toBe(403);
  expect(all.get(3)!.head?.status).toBe(403);
  expect(all.get(4)!.head?.status).toBe(200);

  // The same app over a socket would see a real Host, and refuse it.
  const direct = await app.request("http://localhost/api/config", {
    headers: { host: "localhost", "x-gitui": "1" },
  });
  expect(direct.status).toBe(403);
});
