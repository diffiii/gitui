import { chunks, frameChunk, parseChunk, type ChannelMessage } from "@gitui/shared";

// HTTP over the nearby data channel (see @gitui/shared nearby.ts): a request is a `req` head,
// its body as binary frames and an `end`; the host answers with `res`, frames and `end`, or
// `abort`. Nothing here knows about WebRTC: a ChannelTransport is anything that sends text and
// binary messages in order and reports its send buffer, so tests drive it with in-memory fakes.

export interface ChannelTransport {
  send(data: string | Uint8Array<ArrayBuffer>): void;
  /** Bytes queued but not yet sent. */
  readonly bufferedAmount: number;
  /** Resolves once the send buffer has drained below the transport's low-water mark. */
  drained(): Promise<void>;
}

/** Above this many queued bytes, senders wait for the buffer to drain before sending more. */
export const SEND_HIGH_WATER = 1024 * 1024;

/** An incoming data channel message, decoded; `invalid` for anything the protocol doesn't allow. */
export type Incoming =
  | { kind: "message"; message: ChannelMessage }
  | { kind: "chunk"; id: number; payload: Uint8Array }
  | { kind: "invalid"; reason: string };

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isHeaders = (v: unknown): v is [string, string][] =>
  Array.isArray(v) &&
  v.every(
    (h) =>
      Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string",
  );

/** The fields each message type must have, checked before the message is trusted. */
function isChannelMessage(v: Record<string, unknown>): boolean {
  switch (v.t) {
    case "auth-ok":
      return true;
    case "auth-fail":
      return isId(v.attemptsLeft);
    case "res":
      return isId(v.id) && Number.isInteger(v.status) && isHeaders(v.headers);
    case "end":
      return isId(v.id);
    case "abort":
      return isId(v.id) && typeof v.message === "string";
    default:
      // `auth` and `req` only ever go from guest to host.
      return false;
  }
}

/** Decode a message from the host: JSON text is a ChannelMessage, binary is a body frame. */
export function decodeIncoming(data: string | ArrayBuffer | Uint8Array): Incoming {
  if (typeof data !== "string") {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength < 4) return { kind: "invalid", reason: "frame shorter than its header" };
    return { kind: "chunk", ...parseChunk(bytes) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: "invalid", reason: "message isn't JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "message isn't an object" };
  }
  return isChannelMessage(parsed as Record<string, unknown>)
    ? { kind: "message", message: parsed as ChannelMessage }
    : { kind: "invalid", reason: `unexpected message ${JSON.stringify(parsed).slice(0, 80)}` };
}

/** The messages that carry a request: its head, its body in frames, then `end`. */
export function* encodeRequest(
  id: number,
  head: { method: string; path: string; headers: [string, string][] },
  body: Uint8Array,
): Generator<string | Uint8Array<ArrayBuffer>> {
  yield JSON.stringify({ t: "req", id, ...head } satisfies ChannelMessage);
  for (const chunk of chunks(body)) yield frameChunk(id, chunk) as Uint8Array<ArrayBuffer>;
  yield JSON.stringify({ t: "end", id } satisfies ChannelMessage);
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
  head?: { status: number; headers: [string, string][] };
  body: Uint8Array[];
}

export class ChannelClosedError extends Error {
  override name = "ChannelClosedError";
}

/** The host answered a request with `abort`, or broke the protocol while answering it. */
export class ChannelRequestError extends Error {
  override name = "ChannelRequestError";
}

export interface ChannelClient {
  /** `fetch` for paths on the host, e.g. `/api/config`. Resolves once the whole body arrived. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Feed every message the channel receives (after auth) here. */
  receive(data: string | ArrayBuffer | Uint8Array): void;
  /** Fail every request in flight, and any made later; the channel is gone. */
  close(reason: string): void;
}

/**
 * HTTP client over a channel. Request ids increase from 1, so responses to concurrent requests
 * can interleave. `onProtocolError` hears about messages it drops: garbage, or answers to ids
 * it isn't waiting for (e.g. requests whose caller aborted).
 */
export function createChannelClient(
  transport: ChannelTransport,
  onProtocolError: (reason: string) => void = () => {},
): ChannelClient {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed: string | null = null;

  const fail = (id: number, error: Error) => {
    pending.get(id)?.reject(error);
    pending.delete(id);
  };

  async function send(id: number, request: Request, path: string) {
    const body = new Uint8Array(await request.arrayBuffer());
    const head = { method: request.method, path, headers: [...request.headers] };
    for (const message of encodeRequest(id, head, body)) {
      if (!pending.has(id)) return; // aborted or closed while sending
      if (transport.bufferedAmount > SEND_HIGH_WATER) await transport.drained();
      if (!pending.has(id)) return;
      transport.send(message);
    }
  }

  return {
    fetch(path, init) {
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
        pending.set(id, { resolve, reject, body: [] });
        const { signal } = request;
        if (signal.aborted) return fail(id, signal.reason);
        // The protocol can't cancel a request on the host, so an aborted request only stops
        // waiting; whatever the host still sends for it is dropped as an unknown id.
        signal.addEventListener("abort", () => fail(id, signal.reason), { once: true });
        send(id, request, url.pathname + url.search).catch((e: unknown) =>
          fail(id, e instanceof Error ? e : new Error(String(e))),
        );
      });
    },

    receive(data) {
      const incoming = decodeIncoming(data);
      if (incoming.kind === "invalid") return onProtocolError(incoming.reason);
      if (incoming.kind === "chunk") {
        const request = pending.get(incoming.id);
        if (!request) return onProtocolError(`frame for unknown request ${incoming.id}`);
        if (!request.head) {
          return fail(incoming.id, new ChannelRequestError("body frame before the response head"));
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
      if (!request) return onProtocolError(`${message.t} for unknown request ${message.id}`);
      switch (message.t) {
        case "res":
          if (request.head)
            return fail(message.id, new ChannelRequestError("second response head"));
          request.head = { status: message.status, headers: message.headers };
          return;
        case "abort":
          return fail(message.id, new ChannelRequestError(message.message));
        case "end": {
          if (!request.head) {
            return fail(message.id, new ChannelRequestError("end before the response head"));
          }
          pending.delete(message.id);
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
    },

    close(reason) {
      closed ??= reason;
      for (const id of [...pending.keys()]) fail(id, new ChannelClosedError(reason));
    },
  };
}
