// The host's connection to the rendezvous service (the contract's step 1): announces this
// machine to guests on the same network and relays WebRTC signals. Reconnects with backoff.
import type { ClientMessage, ServerMessage, SignalData } from "@gitui/shared";

/**
 * Keepalive the host sends every PING_INTERVAL. The rendezvous object answers it without waking
 * (a Durable Object auto-response); any reply is ignored, as is every non-JSON message.
 */
export const PING = "ping";
export const PING_INTERVAL = 30_000;

/** Reconnection delays double from the first to the last, with jitter. */
export const BACKOFF = { first: 1000, max: 60_000 };

/** The largest SDP the host accepts from a guest; a data-channel offer is a few kilobytes. */
const MAX_SDP = 64 * 1024;

export interface RendezvousEvents {
  /** The service took the `hello`; the host is listed under `id` until the socket drops. */
  welcome: (id: string) => void;
  /** The socket closed, or couldn't open; a reconnection is scheduled. */
  down: () => void;
  signal: (from: string, data: SignalData) => void;
  /** Peer `id` disconnected. */
  gone: (id: string) => void;
  /** The service reported an error. */
  error: (message: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optional = (value: unknown, type: "string" | "number") =>
  value === undefined || value === null || typeof value === type;

/** The signal in `value` if it is a well-formed one, else null. */
export function parseSignal(value: unknown): SignalData | null {
  if (!isRecord(value)) return null;
  const { kind, sdp, candidate } = value;
  if (kind === "offer" || kind === "answer") {
    return typeof sdp === "string" && sdp.length <= MAX_SDP ? { kind, sdp } : null;
  }
  if (kind === "candidate" && isRecord(candidate) && typeof candidate.candidate === "string") {
    const { candidate: line, sdpMid, sdpMLineIndex } = candidate;
    if (!optional(sdpMid, "string") || !optional(sdpMLineIndex, "number")) return null;
    return {
      kind,
      candidate: {
        candidate: line,
        sdpMid: sdpMid as string | null | undefined,
        sdpMLineIndex: sdpMLineIndex as number | null | undefined,
      },
    };
  }
  return null;
}

/** The message in a text frame from the service, or null if it isn't one a host handles. */
export function parseServerMessage(text: string): ServerMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;
  const { type, id, from, data } = message;
  switch (type) {
    case "welcome":
    case "gone":
      return typeof id === "string" ? { type, id } : null;
    case "signal": {
      const signal = parseSignal(data);
      return typeof from === "string" && signal ? { type, from, data: signal } : null;
    }
    case "error":
      return { type, message: String(message.message) };
    default:
      // Hosts get no `hosts` lists.
      return null;
  }
}

/** The delay before reconnection attempt `attempt` (0 for the first). */
export function backoffDelay(attempt: number, { first, max } = BACKOFF) {
  return Math.min(max, first * 2 ** attempt) * (0.5 + Math.random() / 2);
}

export class RendezvousClient {
  readonly #url: string;
  readonly #name: string;
  readonly #events: RendezvousEvents;
  readonly #backoff: typeof BACKOFF;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(url: string, name: string, events: RendezvousEvents, backoff = BACKOFF) {
    this.#url = url;
    this.#name = name;
    this.#events = events;
    this.#backoff = backoff;
  }

  start() {
    this.#connect();
  }

  /** Relays `data` to peer `to`; dropped while the socket is down. */
  send(to: string, data: SignalData) {
    this.#send({ type: "signal", to, data });
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#socket?.close();
  }

  #send(message: ClientMessage) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #connect() {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    let ping: ReturnType<typeof setInterval> | undefined;

    socket.onopen = () => {
      this.#send({ type: "hello", role: "host", name: this.#name });
      ping = setInterval(() => socket.send(PING), PING_INTERVAL);
    };
    socket.onmessage = ({ data }) => {
      const message = typeof data === "string" ? parseServerMessage(data) : null;
      switch (message?.type) {
        case "welcome":
          this.#attempt = 0;
          return this.#events.welcome(message.id);
        case "signal":
          return this.#events.signal(message.from, message.data);
        case "gone":
          return this.#events.gone(message.id);
        case "error":
          return this.#events.error(message.message);
      }
    };
    // A socket that fails to open fires `error` then `close`, so `close` covers both.
    socket.onclose = () => {
      clearInterval(ping);
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#stopped) return;
      this.#events.down();
      this.#timer = setTimeout(() => this.#connect(), backoffDelay(this.#attempt++, this.#backoff));
    };
  }
}
