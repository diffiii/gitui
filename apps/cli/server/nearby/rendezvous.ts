// The host's connection to the rendezvous service (the contract's step 1): announces this
// machine to guests on the same network and relays WebRTC signals. One rendezvousClient keeps
// one socket, pinned to an IP family, alive for as long as its scope: a fiber opens the socket,
// pings it, and reconnects with backoff when it closes. Socket events are handled as they come,
// in the socket's callbacks.
import { Deferred, Effect, Exit, Option, type Scope } from "effect";
import {
  type ClientMessage,
  type ErrorCode,
  parseServerMessage,
  type SentSignal,
  type SignalData,
} from "@gitui/shared";
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
  /** The service reported an error; all but `unknown-peer` close the socket. */
  error: (code: ErrorCode, message: string) => void;
}

/** The delay before reconnection attempt `attempt` (0 for the first). */
export function backoffDelay(attempt: number, { first, max } = BACKOFF) {
  return Math.min(max, first * 2 ** attempt) * (0.5 + Math.random() / 2);
}

export interface RendezvousOptions {
  url: string;
  family: Family;
  /** The `hello`'s name and secret (HOST_SECRET). */
  name: string;
  secret: string;
  events: RendezvousEvents;
  backoff?: typeof BACKOFF;
  keepalive?: typeof KEEPALIVE;
  open?: SocketFactory;
}

/** A live rendezvous connection, kept up until its scope closes. */
export interface RendezvousClient {
  readonly family: Family;
  /** Relays `data` to peer `to`; dropped while the socket is down. */
  send(to: string, data: SentSignal): void;
}

/**
 * Connects to the rendezvous service and stays connected until the scope closes, which closes
 * the socket and stops reconnecting. The first socket opens before this returns.
 */
export const rendezvousClient = (
  options: RendezvousOptions,
): Effect.Effect<RendezvousClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { url, family, name, secret, events } = options;
    const { interval, timeout } = options.keepalive ?? KEEPALIVE;
    let socket: RendezvousSocket | null = null;
    let attempt = 0;
    /** Set when the scope closes: a socket closing then isn't `down`. */
    let stopped = false;

    const send = (message: ClientMessage) => {
      if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
    };

    /** One socket, from opening it until it closes. */
    const connection = Effect.gen(function* () {
      const opened = Deferred.makeUnsafe<void>();
      const closed = Deferred.makeUnsafe<void>();
      /** Done by the next pong; the keepalive makes a new one for each ping. */
      let pong = Deferred.makeUnsafe<void>();
      const ws = yield* Effect.acquireRelease(
        Effect.sync(() => (options.open ?? openSocket)(url, family)),
        (ws) => Effect.sync(() => ws.close()),
      );
      socket = ws;
      ws.on("open", () => {
        send({ type: "hello", role: "host", name, secret });
        Deferred.doneUnsafe(opened, Exit.void);
      });
      ws.on("pong", () => void Deferred.doneUnsafe(pong, Exit.void));
      ws.on("message", (data, isBinary) => {
        if (socket !== ws) return;
        // Hosts get no `hosts` lists, and send no text pings to get `pong`s for.
        const message = isBinary ? null : parseServerMessage(String(data));
        switch (message?.type) {
          case "welcome":
            attempt = 0;
            return events.welcome(message.id);
          case "signal":
            return events.signal(message.from, message.data);
          case "gone":
            return events.gone(message.id);
          case "error":
            return events.error(message.code, message.message);
        }
      });
      // A socket that fails to open emits `error`, then `close`, so `close` covers both.
      ws.on("error", () => {});
      ws.on("close", () => {
        if (socket !== ws) return;
        socket = null;
        Deferred.doneUnsafe(closed, Exit.void);
        if (!stopped) events.down();
      });
      /** Pings `ws` every `interval`; one without a pong `timeout` later ends it. */
      const keepalive = Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(interval);
          pong = Deferred.makeUnsafe<void>();
          ws.ping();
          const answered = yield* Effect.timeoutOption(Deferred.await(pong), timeout);
          if (Option.isNone(answered)) return ws.terminate();
        }
      });
      yield* Effect.forkScoped(Effect.andThen(Deferred.await(opened), keepalive));
      yield* Deferred.await(closed);
    }).pipe(Effect.scoped);

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(connection, () => Effect.sleep(backoffDelay(attempt++, options.backoff))),
      ),
      { startImmediately: true },
    );
    // Added last, so it runs first: the socket the loop's interruption closes isn't `down`.
    yield* Effect.addFinalizer(() => Effect.sync(() => void (stopped = true)));

    return { family, send: (to, data) => send({ type: "signal", to, data }) };
  });
