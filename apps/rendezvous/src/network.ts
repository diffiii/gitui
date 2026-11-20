// What one network's rendezvous object decides: who may connect, `hello`, signal routing, who
// learns that a peer left, the host list and each socket's budget. Pure, over plain records, so
// it can be unit-tested; rendezvous.ts adapts it to the Durable Object's WebSockets.
import {
  type ErrorCode,
  hostKey,
  type HostInfo,
  MAX_MESSAGE_LENGTH,
  parseClientMessage,
  RATE_WINDOW,
  type ServerMessage,
} from "@gitui/shared";

export { RATE_WINDOW };

/** Most sockets one network may hold open. */
export const MAX_SOCKETS = 50;
/**
 * Most hosts one network may hold, counted by key, so hosts can't take every socket from guests.
 * A socket whose key is already here is always let in, up to MAX_SOCKETS_PER_KEY: a CLI's
 * IPv4 and IPv6 sockets may share this object, and a stale one may linger after it reconnects
 * (it keeps its secret for the whole run). The key is hostKey(secret), so only sockets with the
 * same secret take its slots.
 */
export const MAX_HOSTS = 10;
export const MAX_SOCKETS_PER_KEY = 3;
/** How long a socket may stay open without saying hello once others want to connect, in ms. */
export const HELLO_TIMEOUT = 10_000;

// Every message other than the keepalive wakes the object and is billed, so each is counted, in
// fixed windows of RATE_WINDOW ms (`floor(now / RATE_WINDOW)`, one clock for every budget). A
// message over a limit is refused and closes its socket; it woke the object all the same.
//
// The worst case per window, with the sockets a network may hold at once: a socket that isn't a
// host's sends at most GUEST_RATE_LIMIT + 1, and a host key HOST_RATE_LIMIT plus two per socket
// (its hello, sent before it was a host's, and the message that closes it). The network's
// budgets don't lower that: they close whoever sent the most and stop counting it, so a flood
// spread over many sockets still gets each of them its own limit. The most is MAX_HOSTS keys
// with a socket each and the rest guests: 10 × 258 + 40 × 51 = 4620 messages (about 460 a
// second), and each socket opened during the window can add 51 more, or 258 for a new key in a
// host slot that a closed one freed.

/**
 * What a socket may send per RATE_WINDOW before it says hello and as a guest: enough for a
 * pairing or two (hello, the offer, trickled candidates). Keepalives don't count: they never
 * reach the object.
 */
export const GUEST_RATE_LIMIT = 50;
/**
 * What a host key may send per RATE_WINDOW, over all its sockets. The key is hostKey of a
 * secret, so nobody else's sockets spend it. The CLI takes at most MAX_OFFERS_PER_MINUTE offers
 * (12, all of which may land in one window, since guests that leave or offer again free their
 * pending slots), answering each with an answer and at most MAX_LOCAL_CANDIDATES (16)
 * candidates, and refuses at most MAX_REFUSALS_PER_WINDOW (16) more: 1 + 12 × 17 + 16 = 221
 * (network.test.ts checks this against the shared constants).
 */
export const HOST_RATE_LIMIT = 256;
/**
 * What the network's guests and sockets that haven't said hello may send together per
 * RATE_WINDOW. Over it, the socket that sent the most is closed, whoever sent the last
 * message, and its messages stop counting. Spread over many sockets, a flood closes whichever
 * guest sent the most, which may be one that is pairing.
 */
export const NETWORK_RATE_LIMIT = 200;
/**
 * What the network's hosts may send together per RATE_WINDOW: two keys at their limit, as
 * anyone can say hello as a host. Over it, the key that sent the most has every socket closed
 * and its messages stop counting.
 */
export const NETWORK_HOST_RATE_LIMIT = 2 * HOST_RATE_LIMIT;

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
  /** Its attachment, as last written. */
  read(): Attachment;
  write(attachment: Attachment): void;
  /** False once either side started closing it. */
  readonly open: boolean;
  /** Sends a message; does nothing if the socket is closing. */
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/**
 * Messages counted in window `epoch` (floor(now / RATE_WINDOW)); a budget from an earlier window
 * counts as empty. `counted`: of `n`, those still counted in the network's budget. Kept in
 * memory only: hibernation resets them, which is fine.
 */
interface Budget {
  epoch: number;
  n: number;
  counted: number;
}

const budget = (epoch: number): Budget => ({ epoch, n: 0, counted: 0 });

export type Admission = { attachment: Attachment } | { status: number; message: string };

export class Network {
  /** The budget of each socket that isn't a host's, by peer id. */
  readonly #sockets = new Map<string, Budget>();
  /** The budget of each host key, shared by its sockets. */
  readonly #keys = new Map<string, Budget>();
  /** What guests and sockets that haven't said hello sent, together. */
  readonly #guests = budget(0);
  /** What hosts sent, together. */
  readonly #hosts = budget(0);

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
      const peer = socket.read();
      if (!peer.role && now - peer.opened >= HELLO_TIMEOUT) {
        reject(socket, 1008, "hello-required", "Say hello first");
      }
    }
    if (this.#open().length >= MAX_SOCKETS) {
      return { status: 503, message: "Too many peers on this network" };
    }
    return { attachment: { id: crypto.randomUUID(), browser, opened: now } };
  }

  message(socket: Socket, raw: string | ArrayBuffer): void {
    if (!socket.open) return;
    const peer = socket.read();
    if (!this.#charge(socket, peer)) return;
    if (typeof raw !== "string") {
      return reject(socket, 1003, "invalid-message", "Expected a text message");
    }
    if (raw.length > MAX_MESSAGE_LENGTH)
      return reject(socket, 1009, "too-large", "Message too large");
    const message = parseClientMessage(raw);
    if (!message) return reject(socket, 1008, "invalid-message", "Invalid message");

    if (message.type === "hello") {
      if (peer.role) return reject(socket, 1008, "invalid-message", "Already said hello");
      // Only the web app may list hosts; the CLI connects without an Origin.
      if (message.role === "guest" && !peer.browser) {
        return reject(socket, 1008, "origin-required", "Origin required");
      }
      const { id } = peer;
      let joined: Joined;
      if (message.role === "host") {
        // Only the secret's holder can be listed under its key (the secret isn't kept).
        const key = hostKey(message.secret);
        const hosts = this.peers().filter((other) => other.role === "host");
        const sameKey = hosts.filter((host) => host.key === key).length;
        if (sameKey >= MAX_SOCKETS_PER_KEY) {
          return reject(socket, 1013, "key-limit", "Too many sockets for this host");
        }
        if (!sameKey && new Set(hosts.map((host) => host.key)).size >= MAX_HOSTS) {
          return reject(socket, 1013, "host-limit", "Too many hosts on this network");
        }
        const seq = Math.max(0, ...hosts.map((host) => host.seq)) + 1;
        joined = { role: "host", id, name: message.name, key, seq };
      } else {
        joined = { role: "guest", id };
      }
      socket.write(joined);
      socket.send({ type: "welcome", id });
      if (joined.role === "host") this.#broadcastHosts();
      else socket.send({ type: "hosts", hosts: this.hosts() });
      return;
    }

    if (!peer.role) return reject(socket, 1008, "hello-required", "Say hello first");
    // Signals only go between a guest and a host. A same-role id gets the same answer as an
    // unknown one, so guests can't probe for each other. The rate limit bounds these answers.
    const target = this.peers().find(
      (other) => other.id === message.to && other.role !== peer.role,
    );
    if (!target) {
      return socket.send({ type: "error", code: "unknown-peer", message: "Unknown peer" });
    }
    target.socket.send({ type: "signal", from: peer.id, data: message.data });
  }

  /**
   * A socket closed (this may run twice for one): tells every peer of the other role that it's
   * gone, and guests the new hosts if it was one.
   */
  leave(socket: Socket): void {
    const peer = socket.read();
    this.#sockets.delete(peer.id);
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
      const peer = socket.read();
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

  /**
   * Counts a message from `socket` against its own budget (its key's, for a host) and the
   * network's for its kind. False if that closed `socket`.
   */
  #charge(socket: Socket, peer: Attachment): boolean {
    const epoch = Math.floor(this.now() / RATE_WINDOW);
    const isHost = peer.role === "host";
    const own = isHost ? this.#keyBudget(peer.key, epoch) : this.#socketBudget(peer.id, epoch);
    if (own.n >= (isHost ? HOST_RATE_LIMIT : GUEST_RATE_LIMIT)) {
      reject(socket, 1008, "rate-limit", "Too many messages");
      return false;
    }
    own.n++;
    own.counted++;
    const network = current(isHost ? this.#hosts : this.#guests, epoch);
    if (++network.n <= (isHost ? NETWORK_HOST_RATE_LIMIT : NETWORK_RATE_LIMIT)) return true;
    // Close whoever sent the most, which is rarely the one that tipped it over, and stop
    // counting its messages against everyone else.
    const [sockets, top] = isHost ? this.#topKey(epoch) : this.#topSocket(epoch);
    network.n -= top.counted;
    top.counted = 0;
    for (const flooder of sockets) {
      reject(flooder, 1013, "network-rate-limit", "Too many messages on this network");
    }
    return socket.open;
  }

  /** The open socket other than a host's whose messages count the most, with its budget. */
  #topSocket(epoch: number): [Socket[], Budget] {
    let top: [Socket[], Budget] | null = null;
    for (const socket of this.#open()) {
      const peer = socket.read();
      const budget = this.#sockets.get(peer.id);
      if (peer.role === "host" || budget?.epoch !== epoch) continue;
      if (!top || budget.counted > top[1].counted) top = [[socket], budget];
    }
    // The socket that sent the last message is a candidate, so there is one.
    return top!;
  }

  /** The host key whose messages count the most, with its open sockets and its budget. */
  #topKey(epoch: number): [Socket[], Budget] {
    let top: [string, Budget] | null = null;
    for (const [key, budget] of this.#keys) {
      if (budget.epoch !== epoch) continue;
      if (!top || budget.counted > top[1].counted) top = [key, budget];
    }
    // The key that sent the last message is a candidate, so there is one.
    const [key, budget] = top!;
    const sockets = this.peers().flatMap((p) =>
      p.role === "host" && p.key === key ? [p.socket] : [],
    );
    return [sockets, budget];
  }

  #socketBudget(id: string, epoch: number): Budget {
    let found = this.#sockets.get(id);
    if (!found) this.#sockets.set(id, (found = budget(epoch)));
    return current(found, epoch);
  }

  /**
   * A key's budget. It outlives the key's sockets until its window is over, so reconnecting
   * doesn't start it over; budgets of earlier windows are dropped as new keys come.
   */
  #keyBudget(key: string, epoch: number): Budget {
    let found = this.#keys.get(key);
    if (!found) {
      for (const [other, old] of this.#keys) if (old.epoch !== epoch) this.#keys.delete(other);
      this.#keys.set(key, (found = budget(epoch)));
    }
    return current(found, epoch);
  }
}

/** `budget`, emptied if it is from a window before `epoch`. */
function current(budget: Budget, epoch: number): Budget {
  if (budget.epoch !== epoch) {
    budget.epoch = epoch;
    budget.n = 0;
    budget.counted = 0;
  }
  return budget;
}

function reject(socket: Socket, close: number, code: ErrorCode, message: string): void {
  socket.send({ type: "error", code, message });
  socket.close(close, message);
}
