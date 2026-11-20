// The host's connection to the rendezvous service (the contract's step 1): announces this
// machine to guests on the same network and relays WebRTC signals. One RendezvousClient keeps
// one socket, pinned to an IP family, alive: it pings, and reconnects with backoff.
import type { ClientMessage, ServerMessage, SignalData } from "@gitui/shared";
import { WebSocket } from "ws";

/**
 * Keepalive: a WebSocket protocol ping every PING_INTERVAL, which the service answers without
 * waking. A socket with no pong PONG_TIMEOUT later is dead (e.g. half-open after the network
 * changed) and is replaced.
 */
export const KEEPALIVE = { interval: 30_000, timeout: 10_000 };

/** Reconnection delays double from the first to the last, with jitter. */
export const BACKOFF = { first: 1000, max: 60_000 };

/** How long opening a socket may take. */
const HANDSHAKE_TIMEOUT = 15_000;

/** The largest message taken from the service; signals are a few kilobytes. */
const MAX_PAYLOAD = 256 * 1024;

/** The largest SDP the host accepts from a guest; a data-channel offer is a few kilobytes. */
const MAX_SDP = 64 * 1024;

export type Family = 4 | 6;

/** What the client needs of a WebSocket: the part of `ws`'s that it uses. */
export interface RendezvousSocket {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  /** Drops the connection at once, without a closing handshake. */
  terminate(): void;
  close(): void;
  on(event: "open" | "pong", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Opens a socket to `url` over IP family `family`. */
export type SocketFactory = (url: string, family: Family) => RendezvousSocket;

export const openSocket: SocketFactory = (url, family) =>
  new WebSocket(url, { family, handshakeTimeout: HANDSHAKE_TIMEOUT, maxPayload: MAX_PAYLOAD });

/** WebSocket.OPEN. */
const OPEN = 1;

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
      // Hosts get no `hosts` lists, and send no text pings to get `pong`s for.
      return null;
  }
}

/** The delay before reconnection attempt `attempt` (0 for the first). */
export function backoffDelay(attempt: number, { first, max } = BACKOFF) {
  return Math.min(max, first * 2 ** attempt) * (0.5 + Math.random() / 2);
}

export interface RendezvousOptions {
  url: string;
  family: Family;
  /** The `hello`'s name and key. */
  name: string;
  key: string;
  events: RendezvousEvents;
  backoff?: typeof BACKOFF;
  keepalive?: typeof KEEPALIVE;
  open?: SocketFactory;
}

export class RendezvousClient {
  readonly family: Family;
  readonly #options: RendezvousOptions;
  #socket: RendezvousSocket | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: RendezvousOptions) {
    this.family = options.family;
    this.#options = options;
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
    if (this.#socket?.readyState === OPEN) this.#socket.send(JSON.stringify(message));
  }

  #connect() {
    const { url, family, name, key, events } = this.#options;
    const { interval, timeout } = this.#options.keepalive ?? KEEPALIVE;
    const socket = (this.#options.open ?? openSocket)(url, family);
    this.#socket = socket;
    let ping: ReturnType<typeof setInterval> | undefined;
    let pong: ReturnType<typeof setTimeout> | undefined;

    socket.on("open", () => {
      this.#send({ type: "hello", role: "host", name, key });
      ping = setInterval(() => {
        // One ping at a time: the timeout ends the socket before the next is due.
        if (pong !== undefined) return;
        socket.ping();
        pong = setTimeout(() => socket.terminate(), timeout);
      }, interval);
    });
    socket.on("pong", () => {
      clearTimeout(pong);
      pong = undefined;
    });
    socket.on("message", (data, isBinary) => {
      if (this.#socket !== socket) return;
      const message = isBinary ? null : parseServerMessage(String(data));
      switch (message?.type) {
        case "welcome":
          this.#attempt = 0;
          return events.welcome(message.id);
        case "signal":
          return events.signal(message.from, message.data);
        case "gone":
          return events.gone(message.id);
        case "error":
          return events.error(message.message);
      }
    });
    // A socket that fails to open emits `error`, then `close`, so `close` covers both.
    socket.on("error", () => {});
    socket.on("close", () => {
      clearInterval(ping);
      clearTimeout(pong);
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#stopped) return;
      events.down();
      this.#timer = setTimeout(
        () => this.#connect(),
        backoffDelay(this.#attempt++, this.#options.backoff),
      );
    });
  }
}
