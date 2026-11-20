// What one network's rendezvous object decides: who may connect, `hello`, signal routing, who
// learns that a peer left, the host list and each socket's budget. Pure, over plain records, so
// it can be unit-tested; rendezvous.ts adapts it to the Durable Object's WebSockets.
import { MAX_MESSAGE_LENGTH, parseClientMessage, type HostInfo, type ServerMessage } from "@gitui/shared";

/** Most sockets one network may hold open. */
export const MAX_SOCKETS = 50;
/** Most host sockets one network may hold, so hosts can't take every socket from guests. */
export const MAX_HOSTS = 10;
/** How long a socket may stay open without saying hello once others want to connect, in ms. */
export const HELLO_TIMEOUT = 10_000;
/**
 * Each socket may send RATE_LIMIT messages per RATE_WINDOW ms (every one wakes the object and is
 * billed). Pairing takes about 10 to 30 (hello, offer or answer, trickled candidates), so a host
 * can pair with a few guests at once. Keepalives don't count: they never reach the object.
 */
export const RATE_LIMIT = 50;
export const RATE_WINDOW = 10_000;
/**
 * All the network's sockets together may send this many per RATE_WINDOW, so filling the network
 * with sockets doesn't multiply RATE_LIMIT by MAX_SOCKETS. Enough for several pairings at once.
 */
export const NETWORK_RATE_LIMIT = 200;
/**
 * `Unknown peer` errors a socket gets before it's closed. A guest's candidates still in flight
 * when its host leaves each get one.
 */
export const MAX_ERRORS = 20;

/**
 * A peer that said hello. `seq` orders hosts by when they joined: one more than the highest of
 * the hosts online then. (Date.now() doesn't advance between messages without I/O, so it can't.)
 */
type Joined =
  | { role: "guest"; id: string }
  | { role: "host"; id: string; name: string; key: string; seq: number };

type Host = Extract<Joined, { role: "host" }>;

/**
 * A socket's attachment (it survives hibernation). Before `hello`, `browser` says whether the
 * upgrade had an Origin, which the Worker only lets through when it's allowed, and `opened` is
 * when the socket connected (Date.now()).
 */
export type Attachment =
  | { role?: undefined; id: string; browser: boolean; opened: number }
  | Joined;

/** One of the object's sockets. */
export interface Socket {
  attachment: Attachment;
  /** False once either side started closing it. */
  readonly open: boolean;
  /** Sends a message; does nothing if the socket is closing. */
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** A socket's message budget, kept in memory only: hibernation resets it, which is fine. */
interface Budget {
  /** Messages since `since`. */
  n: number;
  since: number;
  /** `Unknown peer` errors so far. */
  errors: number;
}

export type Admission = { attachment: Attachment } | { status: number; message: string };

export class Network {
  readonly #budgets = new Map<string, Budget>();
  readonly #total: Budget = { n: 0, since: 0, errors: 0 };

  /** `sockets` lists every socket the object holds, open or closing. */
  constructor(
    private readonly sockets: () => Socket[],
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Decides on a new socket (`browser`: the upgrade had an Origin): its first attachment, or a
   * 503 when the network is full. Closes the sockets that never said hello first, so silent
   * sockets can't hold the slots.
   */
  connect(browser: boolean): Admission {
    const now = this.now();
    for (const socket of this.#open()) {
      const peer = socket.attachment;
      if (!peer.role && now - peer.opened >= HELLO_TIMEOUT) reject(socket, 1008, "Say hello first");
    }
    if (this.#open().length >= MAX_SOCKETS) {
      return { status: 503, message: "Too many peers on this network" };
    }
    return { attachment: { id: crypto.randomUUID(), browser, opened: now } };
  }

  message(socket: Socket, raw: string | ArrayBuffer): void {
    if (!socket.open) return;
    const peer = socket.attachment;
    const budget = this.#budget(peer.id);
    if (++budget.n > RATE_LIMIT) return reject(socket, 1008, "Too many messages");
    if (++this.#window(this.#total).n > NETWORK_RATE_LIMIT) {
      return reject(socket, 1013, "Too many messages on this network");
    }
    if (typeof raw !== "string") return reject(socket, 1003, "Expected a text message");
    if (raw.length > MAX_MESSAGE_LENGTH) return reject(socket, 1009, "Message too large");
    const message = parseClientMessage(raw);
    if (!message) return reject(socket, 1008, "Invalid message");

    if (message.type === "hello") {
      if (peer.role) return reject(socket, 1008, "Already said hello");
      // Only the web app may list hosts; the CLI connects without an Origin.
      if (message.role === "guest" && !peer.browser) return reject(socket, 1008, "Origin required");
      const { id } = peer;
      let joined: Joined;
      if (message.role === "host") {
        const hosts = this.peers().filter((other) => other.role === "host");
        if (hosts.length >= MAX_HOSTS)
          return reject(socket, 1013, "Too many hosts on this network");
        const seq = Math.max(0, ...hosts.map((host) => host.seq)) + 1;
        joined = { role: "host", id, name: message.name, key: message.key, seq };
      } else {
        joined = { role: "guest", id };
      }
      socket.attachment = joined;
      socket.send({ type: "welcome", id });
      if (joined.role === "host") this.#broadcastHosts();
      else socket.send({ type: "hosts", hosts: this.hosts() });
      return;
    }

    if (!peer.role) return reject(socket, 1008, "Say hello first");
    // Signals only go between a guest and a host. A same-role id gets the same answer as an
    // unknown one, so guests can't probe for each other.
    const target = this.peers().find(
      (other) => other.id === message.to && other.role !== peer.role,
    );
    if (!target) {
      if (++budget.errors > MAX_ERRORS) return reject(socket, 1008, "Too many errors");
      return socket.send({ type: "error", message: "Unknown peer" });
    }
    target.socket.send({ type: "signal", from: peer.id, data: message.data });
  }

  /**
   * A socket closed (this may run twice for one): tells every peer of the other role that it's
   * gone, and guests the new hosts if it was one.
   */
  leave(socket: Socket): void {
    const peer = socket.attachment;
    this.#budgets.delete(peer.id);
    if (!peer.role) return;
    for (const other of this.peers()) {
      if (other.role !== peer.role) other.socket.send({ type: "gone", id: peer.id });
    }
    if (peer.role === "host") this.#broadcastHosts(peer.id);
  }

  /**
   * The hosts guests see: one entry per key, sorted by name so guests list them in a stable
   * order. A CLI's IPv4 and IPv6 sockets share a key and land here together when both families
   * map to this network; the one that joined first is listed (so a later socket can't displace
   * it), and the other takes its place if it leaves. Both still accept signals.
   */
  hosts(leaving?: string): HostInfo[] {
    const byKey = new Map<string, Host>();
    for (const peer of this.peers()) {
      if (peer.role !== "host" || peer.id === leaving) continue;
      const listed = byKey.get(peer.key);
      if (!listed || peer.seq < listed.seq) byKey.set(peer.key, peer);
    }
    return [...byKey.values()]
      .map(({ id, name, key }) => ({ id, name, key }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  /** Open sockets that said hello. */
  peers(): (Joined & { socket: Socket })[] {
    return this.#open().flatMap((socket) => {
      const peer = socket.attachment;
      return peer.role ? [{ ...peer, socket }] : [];
    });
  }

  #broadcastHosts(leaving?: string): void {
    const hosts = this.hosts(leaving);
    for (const peer of this.peers()) {
      if (peer.role === "guest") peer.socket.send({ type: "hosts", hosts });
    }
  }

  #open(): Socket[] {
    return this.sockets().filter((socket) => socket.open);
  }

  /** The socket's budget, in a new window if the last one is over. */
  #budget(id: string): Budget {
    let budget = this.#budgets.get(id);
    if (!budget) {
      budget = { n: 0, since: this.now(), errors: 0 };
      this.#budgets.set(id, budget);
    }
    return this.#window(budget);
  }

  /** Starts a new window in `budget` if its last one is over. */
  #window(budget: Budget): Budget {
    const now = this.now();
    if (now - budget.since >= RATE_WINDOW) {
      budget.n = 0;
      budget.since = now;
    }
    return budget;
  }
}

function reject(socket: Socket, code: number, message: string): void {
  socket.send({ type: "error", message });
  socket.close(code, message);
}
