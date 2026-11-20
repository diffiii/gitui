// HTTP over an authenticated data channel (the contract's step 4). The guest sends a `req` head,
// binary body frames and an `end`; the bridge builds a Request, hands it to the app and streams
// the Response back as a `res` head, body frames of at most CHUNK_SIZE bytes and an `end`, or an
// `abort` if the app fails. A guest's `cancel` stops a response. Requests interleave by id.
// Nothing here knows about WebRTC.
import {
  CHANNEL_HIGH_WATER,
  CHANNEL_LOW_WATER,
  chunks,
  decodeChannelMessage,
  frameChunk,
  type GuestMessage,
  type HostMessage,
} from "@gitui/shared";
import { NEARBY_HOST } from "../access.ts";

/** What the bridge needs of a data channel. */
export interface BridgeChannel {
  /** Bytes queued by `send` that haven't left yet. */
  readonly bufferedAmount: number;
  /** Throws once the channel has closed. */
  send(data: string | Uint8Array): void;
  /** Resolves once `bufferedAmount` is at most `threshold`, or the channel has closed. */
  drain(threshold: number): Promise<void>;
}

export type Fetch = (request: Request) => Response | Promise<Response>;

/**
 * Backpressure: a response stops sending once the channel holds more than HIGH_WATER queued
 * bytes, and resumes when it drains to LOW_WATER, so a large diff never sits in memory twice.
 */
export const HIGH_WATER = CHANNEL_HIGH_WATER;
export const LOW_WATER = CHANNEL_LOW_WATER;
/** The most requests a channel may have open (not yet answered) at once. */
export const MAX_OPEN_REQUESTS = 64;
/** The largest request body; the API only takes small JSON bodies. */
export const MAX_REQUEST_BODY = 16 * 1024 * 1024;

const ORIGIN = `http://${NEARBY_HOST}`;

type RequestHead = Extract<GuestMessage, { t: "req" }>;

/** A channel message from the guest, checked. */
export type Incoming =
  | { kind: "req"; head: RequestHead }
  | { kind: "chunk"; id: number; payload: Uint8Array }
  | { kind: "end"; id: number }
  | { kind: "cancel"; id: number }
  /** Not a message the guest may send; `id` is the request it names, if it names one. */
  | { kind: "invalid"; id: number | null; reason: string };

/** Reads one channel message from the guest (@gitui/shared's decodeChannelMessage). */
export function decode(data: string | Uint8Array): Incoming {
  const incoming = decodeChannelMessage(data, "guest");
  if (incoming.kind !== "message") return incoming;
  const { message } = incoming;
  switch (message.t) {
    case "req":
      return { kind: "req", head: message };
    case "end":
    case "cancel":
      return { kind: message.t, id: message.id };
    default:
      // Authentication is over once the bridge has the channel.
      return { kind: "invalid", id: null, reason: `unexpected message "${message.t}"` };
  }
}

interface OpenRequest {
  head: RequestHead;
  /** The body received so far, until the request is dispatched; then null. */
  body: Uint8Array[] | null;
  size: number;
  /** Aborted when the guest or the bridge gives up on the request. */
  controller: AbortController;
}

function concat(parts: Uint8Array[], size: number) {
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return body;
}

/** Serves the requests of one authenticated channel with `fetch`. */
export class Bridge {
  readonly #channel: BridgeChannel;
  readonly #fetch: Fetch;
  readonly #open = new Map<number, OpenRequest>();
  #closed = false;

  constructor(channel: BridgeChannel, fetch: Fetch) {
    this.#channel = channel;
    this.#fetch = fetch;
  }

  /** Handles a message from the guest. Messages that name no open request are dropped. */
  receive(data: string | Uint8Array) {
    if (this.#closed) return;
    const message = decode(data);
    switch (message.kind) {
      case "req": {
        const { id } = message.head;
        if (this.#open.has(id)) return this.#fail(id, "request id already in use");
        if (this.#open.size >= MAX_OPEN_REQUESTS) return this.#fail(id, "too many open requests");
        this.#open.set(id, {
          head: message.head,
          body: [],
          size: 0,
          controller: new AbortController(),
        });
        return;
      }
      case "chunk": {
        const open = this.#open.get(message.id);
        if (!open?.body) return;
        open.size += message.payload.byteLength;
        if (open.size > MAX_REQUEST_BODY) return this.#fail(message.id, "request body too large");
        // A copy: the frame's buffer belongs to the channel.
        open.body.push(message.payload.slice());
        return;
      }
      case "end": {
        const open = this.#open.get(message.id);
        if (open?.body) this.#dispatch(message.id, open, open.body);
        return;
      }
      case "cancel":
        this.#cancel(message.id);
        return;
      case "invalid":
        if (message.id !== null) this.#fail(message.id, message.reason);
    }
  }

  /** Gives up on every open request; the channel is gone. */
  close() {
    this.#closed = true;
    for (const id of [...this.#open.keys()]) this.#cancel(id);
  }

  #dispatch(id: number, open: OpenRequest, body: Uint8Array[]) {
    open.body = null;
    const { method, path, headers } = open.head;
    let request: Request;
    try {
      if (open.size && (method === "GET" || method === "HEAD")) {
        throw new Error(`a ${method} request can't have a body`);
      }
      const init = new Headers(headers);
      // The access policy's proof that the request came through the bridge.
      init.set("host", NEARBY_HOST);
      request = new Request(new URL(path, ORIGIN).href, {
        method,
        headers: init,
        body: open.size ? concat(body, open.size) : undefined,
        signal: open.controller.signal,
      });
    } catch (e) {
      return this.#fail(id, (e as Error).message);
    }
    void this.#respond(id, open, request);
  }

  async #respond(id: number, open: OpenRequest, request: Request) {
    const { signal } = open.controller;
    try {
      const response = await this.#fetch(request);
      if (signal.aborted) {
        await response.body?.cancel();
        return;
      }
      const head: HostMessage = {
        t: "res",
        id,
        status: response.status,
        headers: [...response.headers],
      };
      this.#send(JSON.stringify(head));
      if (response.body && !(await this.#stream(id, response.body, signal))) return;
      this.#send(JSON.stringify({ t: "end", id } satisfies HostMessage));
      this.#forget(id, open);
    } catch (e) {
      if (!signal.aborted) this.#fail(id, (e as Error).message);
    }
  }

  /** Sends `body` as frames of request `id`; false if the request was aborted meanwhile. */
  async #stream(id: number, body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader();
    const cancel = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", cancel);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) return false;
        if (done) return true;
        for (const piece of chunks(value)) {
          if (this.#channel.bufferedAmount > HIGH_WATER) {
            await this.#channel.drain(LOW_WATER);
            if (signal.aborted) return false;
          }
          this.#send(frameChunk(id, piece));
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  /** Sends on the channel; a channel that can't send any more ends every request. */
  #send(data: string | Uint8Array) {
    if (this.#closed) return;
    try {
      this.#channel.send(data);
    } catch {
      this.close();
    }
  }

  /** Ends request `id` with an `abort` to the guest. */
  #fail(id: number, message: string) {
    this.#cancel(id);
    this.#send(JSON.stringify({ t: "abort", id, message } satisfies HostMessage));
  }

  /** Ends request `id` without telling the guest. */
  #cancel(id: number) {
    const open = this.#open.get(id);
    if (!open) return;
    this.#open.delete(id);
    open.controller.abort();
  }

  #forget(id: number, open: OpenRequest) {
    if (this.#open.get(id) === open) this.#open.delete(id);
  }
}
