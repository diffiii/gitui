import {
  CHANNEL_HIGH_WATER,
  chunks,
  decodeChannelMessage,
  frameChunk,
  type GuestMessage,
  type HostMessage,
  type Incoming as ChannelIncoming,
} from "@gitui/shared";

// HTTP over the nearby data channel (see @gitui/shared nearby.ts): a request is a `req` head,
// its body as binary frames and an `end`; the host answers with `res`, frames and `end`, or
// `abort`, unless the guest sent `cancel` first. Nothing here knows about WebRTC: a
// ChannelTransport is anything that sends text and binary messages in order and reports its send
// buffer, so tests drive it with in-memory fakes.

export interface ChannelTransport {
  send(data: string | Uint8Array<ArrayBuffer>): void;
  /** Bytes queued but not yet sent. */
  readonly bufferedAmount: number;
  /** Resolves once the send buffer has drained below the transport's low-water mark. */
  drained(): Promise<void>;
}

/** Above this many queued bytes, senders wait for the buffer to drain before sending more. */
export const SEND_HIGH_WATER = CHANNEL_HIGH_WATER;
/** The largest response body a request takes; past it, the request fails and is cancelled. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** An incoming data channel message from the host, decoded (@gitui/shared's codec). */
export type Incoming = ChannelIncoming<HostMessage>;

/** Decode a message from the host: JSON text is a HostMessage, binary is a body frame. */
export const decodeIncoming = (data: string | ArrayBuffer | Uint8Array): Incoming =>
  decodeChannelMessage(data, "host");

/** The messages that carry a request: its head, its body in frames, then `end`. */
export function* encodeRequest(
  id: number,
  head: { method: string; path: string; headers: [string, string][] },
  body: Uint8Array,
): Generator<string | Uint8Array<ArrayBuffer>> {
  yield JSON.stringify({ t: "req", id, ...head } satisfies GuestMessage);
  for (const chunk of chunks(body)) yield frameChunk(id, chunk) as Uint8Array<ArrayBuffer>;
  yield JSON.stringify({ t: "end", id } satisfies GuestMessage);
}

/** Statuses whose responses can't have a body (the Response constructor rejects one). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A request waiting for its response: its head once `res` arrives, and the body so far. */
interface Pending {
  resolve(res: Response): void;
  reject(error: Error): void;
  onHead?: () => void;
  head?: { status: number; headers: [string, string][] };
  body: Uint8Array[];
  /** Body bytes so far. */
  size: number;
}

export class ChannelClosedError extends Error {
  override name = "ChannelClosedError";
}

/** The host answered a request with `abort`, or broke the protocol while answering it. */
export class ChannelRequestError extends Error {
  override name = "ChannelRequestError";
}

/** What a caller hears about its request before it settles. */
export interface FetchProgress {
  /** The response head arrived: the host is answering, and the body follows. */
  onHead?: () => void;
}

export interface ChannelClient {
  /** `fetch` for paths on the host, e.g. `/api/config`. Resolves once the whole body arrived. */
  fetch(path: string, init?: RequestInit, progress?: FetchProgress): Promise<Response>;
  /** Feed every message the channel receives (after auth) here. */
  receive(data: string | ArrayBuffer | Uint8Array): void;
  /** receive() for a message the caller already decoded. */
  handle(incoming: Incoming): void;
  /** Fail every request in flight, and any made later; the channel is gone. */
  close(reason: string): void;
}

/**
 * HTTP client over a channel. Request ids increase from 1, so responses to concurrent requests
 * can interleave. Answers to an id it gave out but no longer waits for (its caller aborted, and
 * the host sends the rest until it sees the `cancel`; the host doesn't confirm a cancel) are
 * dropped quietly. `onProtocolError` hears about the messages it drops otherwise: garbage, or
 * answers to ids it never gave out.
 */
export function createChannelClient(
  transport: ChannelTransport,
  onProtocolError: (reason: string) => void = () => {},
): ChannelClient {
  const pending = new Map<number, Pending>();
  /** Requests whose head went out, so the host knows them and must hear when they're cancelled. */
  const sent = new Set<number>();
  let nextId = 1;
  let closed: string | null = null;

  const fail = (id: number, error: Error) => {
    pending.get(id)?.reject(error);
    pending.delete(id);
    sent.delete(id);
  };

  /** The caller gave up on `id`: stop waiting, and tell the host if it has the request. */
  const cancel = (id: number, reason: Error) => {
    if (!pending.has(id)) return;
    const known = sent.has(id);
    fail(id, reason);
    if (!known || closed !== null) return;
    try {
      transport.send(JSON.stringify({ t: "cancel", id } satisfies GuestMessage));
    } catch {
      // the channel is closing; the host drops the request with it
    }
  };

  async function send(id: number, request: Request, path: string) {
    const body = new Uint8Array(await request.arrayBuffer());
    const head = { method: request.method, path, headers: [...request.headers] };
    for (const message of encodeRequest(id, head, body)) {
      if (!pending.has(id)) return; // aborted or closed while sending
      if (transport.bufferedAmount > SEND_HIGH_WATER) await transport.drained();
      if (!pending.has(id)) return;
      transport.send(message);
      sent.add(id);
    }
  }

  /** A message for `id`, which isn't pending: dropped, and reported unless it was given out. */
  const unknown = (id: number, what: string) => {
    if (id >= nextId) onProtocolError(`${what} for unknown request ${id}`);
  };

  function handle(incoming: Incoming) {
    if (incoming.kind === "invalid") return onProtocolError(incoming.reason);
    if (incoming.kind === "chunk") {
      const request = pending.get(incoming.id);
      if (!request) return unknown(incoming.id, "frame");
      if (!request.head) {
        return fail(incoming.id, new ChannelRequestError("body frame before the response head"));
      }
      request.size += incoming.payload.byteLength;
      if (request.size > MAX_RESPONSE_BYTES) {
        const mib = MAX_RESPONSE_BYTES / 1024 / 1024;
        return cancel(
          incoming.id,
          new ChannelRequestError(`The response is larger than ${mib} MiB, so it was stopped.`),
        );
      }
      // The payload views the channel's buffer; copy it out, the buffer isn't ours to keep.
      request.body.push(incoming.payload.slice());
      return;
    }
    const { message } = incoming;
    if (message.t !== "res" && message.t !== "end" && message.t !== "abort") {
      return onProtocolError(`unexpected ${message.t} message`);
    }
    const request = pending.get(message.id);
    if (!request) return unknown(message.id, message.t);
    switch (message.t) {
      case "res":
        if (request.head) return fail(message.id, new ChannelRequestError("second response head"));
        request.head = { status: message.status, headers: message.headers };
        request.onHead?.();
        return;
      case "abort":
        return fail(message.id, new ChannelRequestError(message.message));
      case "end": {
        if (!request.head) {
          return fail(message.id, new ChannelRequestError("end before the response head"));
        }
        pending.delete(message.id);
        sent.delete(message.id);
        const { status, headers } = request.head;
        try {
          const body = NULL_BODY_STATUSES.has(status) ? null : concat(request.body);
          request.resolve(new Response(body, { status, headers }));
        } catch (e) {
          // A status or header the Response constructor won't take.
          request.reject(new ChannelRequestError(`invalid response: ${String(e)}`));
        }
      }
    }
  }

  return {
    fetch(path, init, progress) {
      if (closed !== null) return Promise.reject(new ChannelClosedError(closed));
      if (!path.startsWith("/")) return Promise.reject(new TypeError(`not a path: ${path}`));
      // Request normalizes the method, headers and any kind of body, and rejects what fetch
      // would (a GET with a body). The origin is a placeholder: only the path goes out.
      let request: Request;
      try {
        request = new Request(new URL(path, "http://gitui.invalid"), init);
      } catch (e) {
        return Promise.reject(e);
      }
      const url = new URL(request.url);
      const id = nextId++;
      return new Promise<Response>((resolve, reject) => {
        pending.set(id, { resolve, reject, onHead: progress?.onHead, body: [], size: 0 });
        const { signal } = request;
        if (signal.aborted) return cancel(id, signal.reason);
        // Whatever the host sent before it saw the `cancel` is dropped as an unknown id.
        signal.addEventListener("abort", () => cancel(id, signal.reason), { once: true });
        send(id, request, url.pathname + url.search).catch((e: unknown) =>
          fail(id, e instanceof Error ? e : new Error(String(e))),
        );
      });
    },

    receive: (data) => handle(decodeIncoming(data)),
    handle,

    close(reason) {
      closed ??= reason;
      sent.clear();
      for (const id of [...pending.keys()]) fail(id, new ChannelClosedError(reason));
    },
  };
}
