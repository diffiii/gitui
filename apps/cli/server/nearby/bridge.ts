// HTTP over an authenticated data channel (the contract's step 4). The guest sends a `req` head,
// binary body frames and an `end`; the bridge builds a Request, hands it to the app and streams
// the Response back as a `res` head, body frames of at most CHUNK_SIZE bytes and an `end`, or an
// `abort` if the app fails. A body over MAX_REQUEST_BODY, or over MAX_BODIES_IN_FLIGHT with the
// others, gets a 413 instead. A guest's `cancel` stops a response. Requests interleave by id.
// A response stops sending once the channel holds more than CHANNEL_HIGH_WATER queued bytes,
// and resumes when it drains to CHANNEL_LOW_WATER, so a large diff never sits in memory twice.
// Each dispatched request is a fiber of the bridge's: a `cancel`, or the bridge closing,
// interrupts it, which aborts the app's request and cancels the response body; a defect in it
// aborts the request too. Nothing here knows about WebRTC.
import {
  CHANNEL_HIGH_WATER,
  CHANNEL_LOW_WATER,
  chunks,
  decodeChannelMessage,
  frameChunk,
  type GuestMessage,
  type HostMessage,
} from "@gitui/shared";
import { Cause, Effect, type Fiber } from "effect";
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

/** The most requests a channel may have open (not yet answered) at once. */
export const MAX_OPEN_REQUESTS = 64;
/** The largest request body; the API only takes small JSON bodies. */
export const MAX_REQUEST_BODY = 1024 * 1024;
/**
 * The most request body bytes a channel may hold at once, over all its open requests (a body
 * is held from its first frame until its request ends).
 */
export const MAX_BODIES_IN_FLIGHT = 16 * 1024 * 1024;

const ORIGIN = `http://${NEARBY_HOST}`;

type RequestHead = Extract<GuestMessage, { t: "req" }>;

interface OpenRequest {
  head: RequestHead;
  /** The body received so far, until the request is dispatched; then null. */
  body: Uint8Array[] | null;
  size: number;
  /** Answers the request once it is dispatched; interrupted when the guest or bridge gives up. */
  fiber: Fiber.Fiber<void> | null;
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

/** The app's request for `head` and `body`, which `signal` aborts; throws if they are no request. */
function toRequest(head: RequestHead, body: Uint8Array | undefined, signal: AbortSignal) {
  const { method, path, headers } = head;
  if (body && (method === "GET" || method === "HEAD")) {
    throw new Error(`a ${method} request can't have a body`);
  }
  const init = new Headers(headers);
  // The access policy's proof that the request came through the bridge.
  init.set("host", NEARBY_HOST);
  return new Request(new URL(path, ORIGIN).href, { method, headers: init, body, signal });
}

/** Serves the requests of one authenticated channel with `fetch`. */
export class Bridge {
  readonly #channel: BridgeChannel;
  readonly #fetch: Fetch;
  readonly #open = new Map<number, OpenRequest>();
  /** The body bytes of every open request. */
  #bodyBytes = 0;
  #closed = false;

  constructor(channel: BridgeChannel, fetch: Fetch) {
    this.#channel = channel;
    this.#fetch = fetch;
  }

  /**
   * Handles a message from the guest. Messages that name no open request are dropped, and so
   * are authentication messages: that is over once the bridge has the channel.
   */
  receive(data: string | Uint8Array) {
    if (this.#closed) return;
    const incoming = decodeChannelMessage(data, "guest");
    switch (incoming.kind) {
      case "chunk":
        return this.#chunk(incoming.id, incoming.payload);
      case "invalid":
        if (incoming.id !== null) this.#fail(incoming.id, incoming.reason);
        return;
    }
    const { message } = incoming;
    switch (message.t) {
      case "req": {
        const { id } = message;
        if (this.#open.has(id)) return this.#fail(id, "request id already in use");
        if (this.#open.size >= MAX_OPEN_REQUESTS) return this.#fail(id, "too many open requests");
        this.#open.set(id, { head: message, body: [], size: 0, fiber: null });
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
    }
  }

  #chunk(id: number, payload: Uint8Array) {
    const open = this.#open.get(id);
    if (!open?.body) return;
    const { byteLength } = payload;
    if (
      open.size + byteLength > MAX_REQUEST_BODY ||
      this.#bodyBytes + byteLength > MAX_BODIES_IN_FLIGHT
    ) {
      return this.#tooLarge(id);
    }
    open.size += byteLength;
    this.#bodyBytes += byteLength;
    // A copy: the frame's buffer belongs to the channel.
    open.body.push(payload.slice());
  }

  /** Gives up on every open request; the channel is gone. */
  close() {
    this.#closed = true;
    for (const id of [...this.#open.keys()]) this.#cancel(id);
  }

  #dispatch(id: number, open: OpenRequest, body: Uint8Array[]) {
    open.body = null;
    open.fiber = Effect.runFork(
      this.#respond(id, open.head, open.size ? concat(body, open.size) : undefined).pipe(
        Effect.map(() => this.#forget(id, open)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;
          const error = Cause.squash(cause);
          return Effect.sync(() =>
            this.#fail(id, error instanceof Error ? error.message : String(error)),
          );
        }),
      ),
    );
  }

  /**
   * Answers request `id` with the app's response to `head` and `body`; interrupting it aborts
   * the request.
   */
  #respond(
    id: number,
    head: RequestHead,
    body: Uint8Array | undefined,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const response = yield* Effect.tryPromise({
        // The fiber's interruption aborts `signal`, and so the app's request.
        try: (signal) => {
          const response = Promise.resolve(this.#fetch(toRequest(head, body, signal)));
          // Given up before the fiber took the response, which tryPromise then drops: its body
          // is cancelled here.
          signal.addEventListener("abort", () => {
            response.then((r) => r.body?.cancel()).catch(() => {});
          });
          return response;
        },
        catch: (e) => e as Error,
      });
      const res: HostMessage = {
        t: "res",
        id,
        status: response.status,
        headers: [...response.headers],
      };
      this.#send(JSON.stringify(res));
      if (response.body) yield* this.#stream(id, response.body);
      this.#send(JSON.stringify({ t: "end", id } satisfies HostMessage));
    });
  }

  /** Sends `body` as frames of request `id`; interrupting it cancels the body. */
  #stream(id: number, body: ReadableStream<Uint8Array>): Effect.Effect<void, Error> {
    return Effect.acquireUseRelease(
      Effect.sync(() => body.getReader()),
      (reader) =>
        Effect.gen({ self: this }, function* () {
          for (;;) {
            const { done, value } = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (e) => e as Error,
            });
            if (done) return;
            for (const piece of chunks(value)) {
              if (this.#channel.bufferedAmount > CHANNEL_HIGH_WATER) {
                yield* Effect.promise(() => this.#channel.drain(CHANNEL_LOW_WATER));
              }
              this.#send(frameChunk(id, piece));
            }
          }
        }),
      (reader, exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.promise(() => reader.cancel().catch(() => {})),
    );
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

  /**
   * Answers request `id` with a 413 and drops its body; the rest of its frames, and its `end`,
   * name no open request any more and are dropped.
   */
  #tooLarge(id: number) {
    this.#cancel(id);
    const body = new TextEncoder().encode(JSON.stringify({ error: "Request body too large" }));
    const head: HostMessage = {
      t: "res",
      id,
      status: 413,
      headers: [["content-type", "application/json"]],
    };
    this.#send(JSON.stringify(head));
    this.#send(frameChunk(id, body));
    this.#send(JSON.stringify({ t: "end", id } satisfies HostMessage));
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
    this.#forget(id, open);
    open.fiber?.interruptUnsafe();
  }

  #forget(id: number, open: OpenRequest) {
    if (this.#open.get(id) !== open) return;
    this.#open.delete(id);
    this.#bodyBytes -= open.size;
  }
}
