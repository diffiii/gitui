import {
  RENDEZVOUS_ORIGIN,
  RENDEZVOUS_PING,
  rendezvousUrl,
  type ClientMessage,
  type HostInfo,
  type ServerMessage,
  type SignalData,
} from "@gitui/shared";
import { parseServerMessage } from "@gitui/shared/nearby-codec";
import { dedupeHosts } from "./state.ts";

// The guest's side of the rendezvous WebSocket: it says hello as a guest, keeps the list of hosts
// on this network as an external store, and relays WebRTC signals to and from them. The socket
// is open while anything subscribes, and reconnects with backoff when it drops. It pings every
// `keepalive`, and a socket that doesn't answer a ping within `pingTimeout`, or is still
// connecting after `watchdog` (Safari can leave one stuck after the page comes back), is
// replaced: browsers keep a dead socket "open" for a long time after the network went away.

export interface RendezvousState {
  /** `connecting`: no socket has been welcomed yet; `retrying`: the last one dropped. */
  status: "connecting" | "open" | "retrying";
  /** Hosts on this network, one per key, as of the last `hosts` message of an open socket. */
  hosts: HostInfo[];
}

export interface SignalHandlers {
  signal(data: SignalData): void;
  /** The peer disconnected from the rendezvous. */
  gone(): void;
}

/** The parts of WebSocket the client uses, so tests can stand in for it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export interface RendezvousOptions {
  url: string;
  connect?: (url: string) => SocketLike;
  /** Milliseconds before reconnect attempt `n` (1-based) after a drop. */
  backoff?: (attempt: number) => number;
  /** How long the socket stays open after the last subscriber leaves (a remount comes back). */
  linger?: number;
  /** Milliseconds between pings while the socket is open. */
  keepalive?: number;
  /** How long a ping may go unanswered (by any message) before the socket is replaced. */
  pingTimeout?: number;
  /** How long a socket may stay connecting before it is replaced. */
  watchdog?: number;
}

const CONNECTING = 0;
const OPEN = 1;

/** 0.5 s, doubling up to 15 s, with jitter so a network's guests don't reconnect in step. */
export const defaultBackoff = (attempt: number) =>
  Math.min(15_000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);

export class Rendezvous {
  #state: RendezvousState = { status: "connecting", hosts: [] };
  readonly #listeners = new Set<() => void>();
  readonly #peers = new Map<string, Set<SignalHandlers>>();
  readonly #options: Required<RendezvousOptions>;
  #socket: SocketLike | null = null;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #linger: ReturnType<typeof setTimeout> | undefined;
  /** The socket's watchdog while it connects, then its unanswered ping's deadline. */
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #keepalive: ReturnType<typeof setInterval> | undefined;

  constructor(options: RendezvousOptions) {
    this.#options = {
      connect: (url) => new WebSocket(url),
      backoff: defaultBackoff,
      linger: 1000,
      keepalive: 30_000,
      pingTimeout: 5000,
      watchdog: 5000,
      ...options,
    };
  }

  getSnapshot = (): RendezvousState => this.#state;

  /** Subscribe to the state; the first subscriber opens the socket, the last one closes it. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#retain();
    return () => {
      this.#listeners.delete(listener);
      this.#release();
    };
  };

  /**
   * Hear the signals `peer` sends, and that it left. Keeps the socket open like a subscriber.
   * Returns the function that stops listening.
   */
  listen(peer: string, handlers: SignalHandlers): () => void {
    let set = this.#peers.get(peer);
    if (!set) this.#peers.set(peer, (set = new Set()));
    set.add(handlers);
    this.#retain();
    return () => {
      set.delete(handlers);
      if (!set.size) this.#peers.delete(peer);
      this.#release();
    };
  }

  /** Send a signal to `peer`. False if the socket isn't open, so the signal is lost. */
  signal(to: string, data: SignalData): boolean {
    return this.#send({ type: "signal", to, data });
  }

  /**
   * The page is back (e.g. iOS resumed it): reconnect now if the socket is down, instead of
   * after the backoff, and ping an open one to find out whether it still works.
   */
  wake() {
    if (!this.#users()) return;
    const socket = this.#socket;
    if (!socket) {
      clearTimeout(this.#retry);
      this.#failures = 0;
      this.#open();
    } else if (socket.readyState === OPEN) {
      this.#ping(socket);
    }
    // A connecting socket has its watchdog.
  }

  #users() {
    return this.#listeners.size + this.#peers.size;
  }

  #retain() {
    clearTimeout(this.#linger);
    if (!this.#socket && this.#retry === undefined) this.#open();
  }

  #release() {
    if (this.#users()) return;
    clearTimeout(this.#linger);
    this.#linger = setTimeout(() => {
      if (!this.#users()) this.#shutDown();
    }, this.#options.linger);
  }

  #shutDown() {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    const socket = this.#socket;
    this.#socket = null;
    this.#stopTimers();
    if (socket) this.#discard(socket);
    this.#failures = 0;
    this.#setState({ status: "connecting", hosts: [] });
  }

  #stopTimers() {
    this.#clearDeadline();
    clearInterval(this.#keepalive);
  }

  #clearDeadline() {
    clearTimeout(this.#deadline);
    this.#deadline = undefined;
  }

  #discard(socket: SocketLike) {
    socket.onclose = socket.onmessage = socket.onopen = null;
    socket.close();
  }

  #open() {
    this.#retry = undefined;
    const socket = this.#options.connect(this.#options.url);
    this.#socket = socket;
    this.#deadline = setTimeout(() => {
      if (socket.readyState === CONNECTING) this.#replace(socket);
    }, this.#options.watchdog);
    socket.onopen = () => {
      this.#clearDeadline();
      this.#send({ type: "hello", role: "guest" });
      this.#keepalive = setInterval(() => this.#ping(socket), this.#options.keepalive);
    };
    socket.onmessage = (event) => {
      this.#clearDeadline(); // anything counts as an answer to a ping
      this.#receive(typeof event.data === "string" ? parseServerMessage(event.data) : null);
    };
    socket.onclose = () => this.#dropped(socket, this.#options.backoff(++this.#failures));
  }

  #ping(socket: SocketLike) {
    if (this.#socket !== socket || socket.readyState !== OPEN) return;
    socket.send(RENDEZVOUS_PING);
    // An earlier ping still unanswered keeps its deadline.
    this.#deadline ??= setTimeout(() => this.#replace(socket), this.#options.pingTimeout);
  }

  /** Give up on a socket that hangs, and open another straight away. */
  #replace(socket: SocketLike) {
    if (this.#socket !== socket) return;
    this.#discard(socket);
    this.#dropped(socket, 0);
  }

  #dropped(socket: SocketLike, retryIn: number) {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#stopTimers();
    // Peers signaling through this socket lose their id with it, so they are gone too.
    for (const handlers of [...this.#peers.values()].flatMap((set) => [...set])) handlers.gone();
    this.#setState({ status: "retrying", hosts: [] });
    this.#retry = setTimeout(() => this.#open(), retryIn);
  }

  #receive(message: ServerMessage | null) {
    switch (message?.type) {
      case "welcome":
        this.#failures = 0;
        this.#setState({ ...this.#state, status: "open" });
        return;
      case "hosts":
        this.#setState({
          status: "open",
          hosts: dedupeHosts(message.hosts),
        });
        return;
      case "signal":
        this.#peers.get(message.from)?.forEach((h) => h.signal(message.data));
        return;
      case "gone":
        this.#peers.get(message.id)?.forEach((h) => h.gone());
        return;
      case "error":
        console.warn("rendezvous:", message.message);
        return;
      case "pong":
        return;
      default:
        console.warn("rendezvous: dropped an unreadable message");
    }
  }

  #send(message: ClientMessage): boolean {
    if (this.#socket?.readyState !== OPEN) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  #setState(next: RendezvousState) {
    this.#state = next;
    this.#listeners.forEach((l) => l());
  }
}

let shared: Rendezvous | undefined;

/**
 * The page's rendezvous client, created on first use. `VITE_GITUI_RENDEZVOUS_URL` replaces the
 * origin at build or dev time, e.g. `ws://127.0.0.1:8787` for `wrangler dev`.
 */
export function rendezvous(): Rendezvous {
  const origin = import.meta.env.VITE_GITUI_RENDEZVOUS_URL || RENDEZVOUS_ORIGIN;
  const url = rendezvousUrl(origin);
  if (!url)
    throw new Error(`VITE_GITUI_RENDEZVOUS_URL must be a ws: or wss: origin, not ${origin}`);
  shared ??= new Rendezvous({ url });
  return shared;
}
