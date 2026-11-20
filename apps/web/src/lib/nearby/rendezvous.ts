import {
  RENDEZVOUS_ORIGIN,
  RENDEZVOUS_PATH,
  type ClientMessage,
  type HostInfo,
  type ServerMessage,
  type SignalData,
} from "@gitui/shared";

// The guest's side of the rendezvous WebSocket: it says hello as a guest, keeps the list of hosts
// on this network as an external store, and relays WebRTC signals to and from them. The socket
// is open while anything subscribes, and reconnects with backoff when it drops.

/**
 * The rendezvous WebSocket URL. `VITE_GITUI_RENDEZVOUS_URL` replaces the origin at build or dev
 * time, e.g. `ws://127.0.0.1:8787` for `wrangler dev`.
 */
export const rendezvousUrl = (origin: string = RENDEZVOUS_ORIGIN) =>
  new URL(RENDEZVOUS_PATH, origin).href;

export interface RendezvousState {
  /** `connecting`: no socket has been welcomed yet; `retrying`: the last one dropped. */
  status: "connecting" | "open" | "retrying";
  /** Hosts on this network, as of the last `hosts` message of an open socket. */
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
}

const OPEN = 1;

/** 0.5 s, doubling up to 15 s, with jitter so a network's guests don't reconnect in step. */
export const defaultBackoff = (attempt: number) =>
  Math.min(15_000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" && message !== null && "type" in message
      ? (message as ServerMessage)
      : null;
  } catch {
    return null;
  }
}

export class Rendezvous {
  #state: RendezvousState = { status: "connecting", hosts: [] };
  readonly #listeners = new Set<() => void>();
  readonly #peers = new Map<string, Set<SignalHandlers>>();
  readonly #options: Required<RendezvousOptions>;
  #socket: SocketLike | null = null;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #linger: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RendezvousOptions) {
    this.#options = {
      connect: (url) => new WebSocket(url),
      backoff: defaultBackoff,
      linger: 1000,
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
    if (socket) {
      socket.onclose = socket.onmessage = socket.onopen = null;
      socket.close();
    }
    this.#failures = 0;
    this.#setState({ status: "connecting", hosts: [] });
  }

  #open() {
    this.#retry = undefined;
    const socket = this.#options.connect(this.#options.url);
    this.#socket = socket;
    socket.onopen = () => this.#send({ type: "hello", role: "guest" });
    socket.onmessage = (event) => this.#receive(parseServerMessage(event.data));
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      // Peers signaling through this socket lose their id with it, so they are gone too.
      for (const handlers of [...this.#peers.values()].flatMap((set) => [...set])) handlers.gone();
      this.#setState({ status: "retrying", hosts: [] });
      this.#retry = setTimeout(() => this.#open(), this.#options.backoff(++this.#failures));
    };
  }

  #receive(message: ServerMessage | null) {
    switch (message?.type) {
      case "welcome":
        this.#failures = 0;
        this.#setState({ ...this.#state, status: "open" });
        return;
      case "hosts":
        this.#setState({ status: "open", hosts: message.hosts });
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

/** The page's rendezvous client, created on first use. */
export function rendezvous(): Rendezvous {
  shared ??= new Rendezvous({
    url: rendezvousUrl(import.meta.env.VITE_GITUI_RENDEZVOUS_URL || undefined),
  });
  return shared;
}
