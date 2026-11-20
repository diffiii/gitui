import { expect, test } from "bun:test";
import {
  type ErrorCode,
  hostKey,
  MAX_LOCAL_CANDIDATES,
  MAX_MESSAGE_LENGTH,
  MAX_OFFERS_PER_MINUTE,
  MAX_REFUSALS_PER_WINDOW,
  type ServerMessage,
} from "@gitui/shared";
import {
  GUEST_RATE_LIMIT,
  HELLO_TIMEOUT,
  HOST_RATE_LIMIT,
  MAX_HOSTS,
  MAX_SOCKETS,
  MAX_SOCKETS_PER_KEY,
  NETWORK_HOST_RATE_LIMIT,
  NETWORK_RATE_LIMIT,
  Network,
  RATE_WINDOW,
  type Attachment,
  type Socket,
} from "./network.ts";

/**
 * A socket that records what it's sent and how it was closed. Like the runtime's, its attachment
 * is a copy on every read, so only write() changes it.
 */
class FakeSocket implements Socket {
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  #attachment: string;
  constructor(attachment: Attachment) {
    this.#attachment = JSON.stringify(attachment);
  }
  read(): Attachment {
    return JSON.parse(this.#attachment) as Attachment;
  }
  write(attachment: Attachment) {
    this.#attachment = JSON.stringify(attachment);
  }
  get open() {
    return this.closed === null;
  }
  send(message: ServerMessage) {
    if (this.open) this.sent.push(message);
  }
  close(code: number, reason: string) {
    this.closed ??= { code, reason };
  }
  /** Takes what was sent so far. */
  take(): ServerMessage[] {
    return this.sent.splice(0);
  }
}

/** A network with a settable clock and helpers to connect and say hello. */
function setup() {
  const sockets: FakeSocket[] = [];
  const clock = { now: 1_000_000 };
  const start = () =>
    new Network(
      () => sockets,
      () => clock.now,
    );
  let network = start();
  /** Hibernation: a new Network over the same sockets, with only their attachments. */
  const hibernate = () => {
    network = start();
  };
  const connect = (browser: boolean) => {
    const admitted = network.connect(browser);
    if ("status" in admitted) throw new Error(`refused: ${admitted.status}`);
    const socket = new FakeSocket(admitted.attachment);
    sockets.push(socket);
    return socket;
  };
  const send = (socket: FakeSocket, message: unknown) =>
    network.message(socket, JSON.stringify(message));
  const leave = (socket: FakeSocket) => {
    socket.close(1000, "");
    network.leave(socket);
  };
  let secrets = 0;
  /** A host that says hello with `secret` (a new one by default). */
  const host = (name = "box", secret = newSecret(secrets++)) => {
    const socket = connect(false);
    send(socket, { type: "hello", role: "host", name, secret });
    const welcome = socket.sent.shift();
    if (welcome?.type !== "welcome") throw new Error(`no welcome: ${JSON.stringify(welcome)}`);
    return Object.assign(socket, { id: welcome.id, key: hostKey(secret), secret });
  };
  const guest = () => {
    const socket = connect(true);
    send(socket, { type: "hello", role: "guest" });
    const welcome = socket.sent.shift();
    if (welcome?.type !== "welcome") throw new Error(`no welcome: ${JSON.stringify(welcome)}`);
    return Object.assign(socket, { id: welcome.id });
  };
  return {
    get network() {
      return network;
    },
    hibernate,
    sockets,
    clock,
    connect,
    send,
    leave,
    host,
    guest,
  };
}

/** A HOST_SECRET-shaped secret, distinct for each `n`. */
const newSecret = (n: number | string) => `secret-${n}`.padEnd(43, "_");

/** An `error` the object sends. */
const error = (code: ErrorCode, message: string): ServerMessage => ({
  type: "error",
  code,
  message,
});

const OFFER = { kind: "offer", offerId: "offer-0123456789ab", sdp: "v=0" } as const;

test("a guest gets its id, then the hosts, and hears of new hosts", () => {
  const { guest, host } = setup();
  const g = guest();
  expect(g.take()).toEqual([{ type: "hosts", hosts: [] }]);
  const h = host("box");
  expect(g.take()).toEqual([{ type: "hosts", hosts: [{ id: h.id, name: "box", key: h.key }] }]);
});

test("hosts lists each key once, the first to join, sorted by name", () => {
  const { network, host, leave } = setup();
  const first = host("box", newSecret("shared"));
  host("box", newSecret("shared"));
  const other = host("attic");
  expect(network.hosts().map((h) => h.id)).toEqual([other.id, first.id]);
  leave(first);
  expect(network.hosts()).toHaveLength(2);
});

test("signals go between a guest and a host", () => {
  const { send, guest, host } = setup();
  const g = guest();
  const h = host();
  send(g, { type: "signal", to: h.id, data: OFFER });
  expect(h.take()).toEqual([{ type: "signal", from: g.id, data: OFFER }]);
  send(h, {
    type: "signal",
    to: g.id,
    data: { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" },
  });
  expect(g.take().at(-1)).toEqual({
    type: "signal",
    from: h.id,
    data: { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" },
  });
});

test("a refusal with a reason this version doesn't know is relayed, as unknown", () => {
  const { send, guest, host } = setup();
  const g = guest();
  const h = host();
  g.take();
  const offerId = OFFER.offerId;
  send(h, { type: "signal", to: g.id, data: { kind: "refused", offerId, reason: "too-new" } });
  expect(g.take()).toEqual([
    { type: "signal", from: h.id, data: { kind: "refused", offerId, reason: "unknown" } },
  ]);
  // The host that sent it is still here.
  expect(h.closed).toBeNull();
  expect(h.take()).toEqual([]);
});

test("a signal to another guest gets Unknown peer, like an unknown id", () => {
  const { send, guest } = setup();
  const a = guest();
  const b = guest();
  a.take();
  b.take();
  send(a, { type: "signal", to: b.id, data: OFFER });
  send(a, { type: "signal", to: "nobody", data: OFFER });
  expect(a.take()).toEqual([
    error("unknown-peer", "Unknown peer"),
    error("unknown-peer", "Unknown peer"),
  ]);
  expect(b.take()).toEqual([]);
});

test("a host signaling another host gets Unknown peer", () => {
  const { send, host } = setup();
  const a = host();
  const b = host();
  send(a, { type: "signal", to: b.id, data: OFFER });
  expect(a.take()).toEqual([error("unknown-peer", "Unknown peer")]);
  expect(b.take()).toEqual([]);
});

test("a guest leaving sends gone to every host, and nothing to other guests", () => {
  const { leave, guest, host } = setup();
  const g = guest();
  const other = guest();
  const hosts = [host(), host()];
  other.take();
  leave(g);
  for (const h of hosts) expect(h.take()).toEqual([{ type: "gone", id: g.id }]);
  expect(other.take()).toEqual([]);
});

test("a host leaving sends gone and the new list to guests, nothing to other hosts", () => {
  const { leave, guest, host } = setup();
  const g = guest();
  const a = host("a");
  const b = host("b");
  g.take();
  leave(a);
  expect(g.take()).toEqual([
    { type: "gone", id: a.id },
    { type: "hosts", hosts: [{ id: b.id, name: "b", key: b.key }] },
  ]);
  expect(b.take()).toEqual([]);
});

test("a socket that never said hello leaves without telling anyone", () => {
  const { network, connect, guest } = setup();
  const g = guest();
  g.take();
  const silent = connect(false);
  silent.close(1000, "");
  network.leave(silent);
  expect(g.take()).toEqual([]);
});

test("a guest without an Origin is refused", () => {
  const { connect, send } = setup();
  const socket = connect(false);
  send(socket, { type: "hello", role: "guest" });
  expect(socket.take()).toEqual([error("origin-required", "Origin required")]);
  expect(socket.closed?.code).toBe(1008);
});

test("a second hello is refused", () => {
  const { send, guest, host } = setup();
  const g = guest();
  send(g, { type: "hello", role: "guest" });
  expect(g.take().at(-1)).toEqual(error("invalid-message", "Already said hello"));
  expect(g.closed?.code).toBe(1008);
  const h = host();
  send(h, { type: "hello", role: "host", name: "again", secret: h.secret });
  expect(h.closed).toEqual({ code: 1008, reason: "Already said hello" });
});

test("a signal before hello is refused", () => {
  const { connect, send } = setup();
  const socket = connect(true);
  send(socket, { type: "signal", to: "x", data: OFFER });
  expect(socket.closed).toEqual({ code: 1008, reason: "Say hello first" });
});

test("binary messages close with 1003, oversized ones with 1009, invalid ones with 1008", () => {
  const { network, connect } = setup();
  const binary = connect(true);
  network.message(binary, new ArrayBuffer(8));
  expect(binary.closed).toEqual({ code: 1003, reason: "Expected a text message" });
  const large = connect(true);
  network.message(large, "x".repeat(MAX_MESSAGE_LENGTH + 1));
  expect(large.closed).toEqual({ code: 1009, reason: "Message too large" });
  const invalid = connect(true);
  network.message(invalid, "{");
  expect(invalid.closed).toEqual({ code: 1008, reason: "Invalid message" });
});

test("the network refuses socket MAX_SOCKETS + 1 with a 503", () => {
  const { network, connect } = setup();
  for (let i = 0; i < MAX_SOCKETS; i++) connect(true);
  expect(network.connect(true)).toEqual({ status: 503, message: "Too many peers on this network" });
});

test("a closed socket frees its slot", () => {
  const { network, sockets, connect } = setup();
  for (let i = 0; i < MAX_SOCKETS; i++) connect(true);
  sockets[0].close(1000, "");
  expect(network.connect(true)).toHaveProperty("attachment");
});

test("connecting closes sockets that stayed silent for HELLO_TIMEOUT", () => {
  const { clock, connect, guest, network } = setup();
  const g = guest();
  const stale = Array.from({ length: MAX_SOCKETS - 2 }, () => connect(false));
  clock.now += HELLO_TIMEOUT - 1;
  const fresh = connect(true);
  expect(network.connect(true)).toMatchObject({ status: 503 });
  for (const socket of stale) expect(socket.closed).toBeNull();
  clock.now += 1;
  // Even when there's room: the next connection closes them.
  const next = network.connect(true);
  expect(next).toHaveProperty("attachment");
  for (const socket of stale)
    expect(socket.closed).toEqual({ code: 1008, reason: "Say hello first" });
  expect(fresh.closed).toBeNull();
  expect(g.closed).toBeNull();
});

test("a full network makes room by closing silent sockets", () => {
  const { clock, connect, network } = setup();
  const stale = Array.from({ length: MAX_SOCKETS }, () => connect(true));
  expect(network.connect(true)).toMatchObject({ status: 503 });
  clock.now += HELLO_TIMEOUT;
  expect(network.connect(true)).toHaveProperty("attachment");
  expect(stale.every((socket) => socket.closed?.code === 1008)).toBe(true);
});

test("a network takes MAX_HOSTS hosts, and guests after that", () => {
  const { connect, send, host, guest, leave } = setup();
  const hosts = Array.from({ length: MAX_HOSTS }, () => host());
  const extra = connect(false);
  send(extra, { type: "hello", role: "host", name: "box", secret: newSecret("one-too-many") });
  expect(extra.take()).toEqual([error("host-limit", "Too many hosts on this network")]);
  expect(extra.closed?.code).toBe(1013);
  expect(guest().take()).toEqual([{ type: "hosts", hosts: expect.any(Array) }]);
  leave(hosts[0]);
  expect(host().closed).toBeNull();
});

test("hosts count by key: a key already here gets in, up to MAX_SOCKETS_PER_KEY sockets", () => {
  const { connect, send, host, leave } = setup();
  // A CLI reconnecting with its key while its old socket lingers.
  const sockets = Array.from({ length: MAX_SOCKETS_PER_KEY }, () =>
    host("box", newSecret("reconnecting")),
  );
  for (let i = 1; i < MAX_HOSTS; i++) host();
  expect(sockets.every((socket) => socket.closed === null)).toBe(true);
  // Full by key, and the key has its sockets.
  const another = connect(false);
  send(another, { type: "hello", role: "host", name: "box", secret: newSecret("reconnecting") });
  expect(another.take()).toEqual([error("key-limit", "Too many sockets for this host")]);
  expect(another.closed?.code).toBe(1013);
  // One of them goes: the key may open another, even though the network is full.
  leave(sockets[0]);
  expect(host("box", newSecret("reconnecting")).closed).toBeNull();
});

test("a guest over GUEST_RATE_LIMIT messages per RATE_WINDOW is closed with 1008", () => {
  const { clock, send, guest, host } = setup();
  const g = guest(); // 1 message
  const h = host();
  for (let i = 1; i < GUEST_RATE_LIMIT; i++) send(g, { type: "signal", to: h.id, data: OFFER });
  expect(g.closed).toBeNull();
  expect(h.take()).toHaveLength(GUEST_RATE_LIMIT - 1);
  send(g, { type: "signal", to: h.id, data: OFFER });
  expect(g.closed).toEqual({ code: 1008, reason: "Too many messages" });
  expect(h.take()).toEqual([]);

  // A new window starts RATE_WINDOW after the first.
  const other = guest();
  for (let round = 0; round < 3; round++) {
    for (let i = round === 0 ? 1 : 0; i < GUEST_RATE_LIMIT; i++) {
      send(other, { type: "signal", to: h.id, data: OFFER });
    }
    clock.now += RATE_WINDOW;
  }
  expect(other.closed).toBeNull();
});

test("HOST_RATE_LIMIT covers the most the CLI sends in a window", () => {
  // An answer and its candidates for every offer the CLI may take in one window, the refusals
  // it may send besides, and a hello.
  const cli = 1 + MAX_OFFERS_PER_MINUTE * (1 + MAX_LOCAL_CANDIDATES) + MAX_REFUSALS_PER_WINDOW;
  expect(HOST_RATE_LIMIT).toBeGreaterThanOrEqual(cli);
  expect(NETWORK_HOST_RATE_LIMIT).toBeGreaterThanOrEqual(HOST_RATE_LIMIT);
});

test("a host key over HOST_RATE_LIMIT per RATE_WINDOW, over all its sockets, is closed", () => {
  const { send, guest, host } = setup();
  const g = guest();
  const secret = newSecret("cli");
  const [v4, v6] = [host("box", secret), host("box", secret)];
  // Its hellos counted as a guest's: a socket isn't a host's until it said hello.
  for (let i = 0; i < HOST_RATE_LIMIT; i++) {
    send(i % 2 ? v4 : v6, { type: "signal", to: g.id, data: OFFER });
  }
  expect(v4.closed ?? v6.closed).toBeNull();
  send(v4, { type: "signal", to: g.id, data: OFFER });
  expect(v4.take().at(-1)).toEqual(error("rate-limit", "Too many messages"));
  expect(v4.closed).toEqual({ code: 1008, reason: "Too many messages" });
  // The key's other socket is over too, and another key isn't.
  send(v6, { type: "signal", to: g.id, data: OFFER });
  expect(v6.closed?.code).toBe(1008);
  const other = host();
  send(other, { type: "signal", to: g.id, data: OFFER });
  expect(other.closed).toBeNull();
});

test("reconnecting doesn't start a key's budget over within its window", () => {
  const { clock, send, guest, host, leave } = setup();
  const g = guest();
  const secret = newSecret("cli");
  const first = host("box", secret);
  for (let i = 0; i < HOST_RATE_LIMIT; i++) send(first, { type: "signal", to: g.id, data: OFFER });
  leave(first);
  const again = host("box", secret);
  send(again, { type: "signal", to: g.id, data: OFFER });
  expect(again.closed?.code).toBe(1008);
  clock.now += RATE_WINDOW;
  const later = host("box", secret);
  send(later, { type: "signal", to: g.id, data: OFFER });
  expect(later.closed).toBeNull();
});

test("budgets count in fixed windows: floor(now / RATE_WINDOW)", () => {
  const { clock, send, guest, host } = setup();
  const h = host();
  clock.now = Math.ceil(clock.now / RATE_WINDOW) * RATE_WINDOW + RATE_WINDOW - 1;
  const g = guest(); // 1 message, in the window that ends in 1 ms
  for (let i = 1; i < GUEST_RATE_LIMIT; i++) send(g, { type: "signal", to: h.id, data: OFFER });
  // The next window starts 1 ms later, not RATE_WINDOW after the guest's first message.
  clock.now += 1;
  for (let i = 0; i < GUEST_RATE_LIMIT; i++) send(g, { type: "signal", to: h.id, data: OFFER });
  expect(g.closed).toBeNull();
  send(g, { type: "signal", to: h.id, data: OFFER });
  expect(g.closed?.code).toBe(1008);
});

test("a host is listed under the hash of its secret, which nobody else can take", () => {
  const { network, connect, send, guest, host } = setup();
  const g = guest();
  const victim = host("box", newSecret("victim"));
  expect(victim.key).toMatch(/^[\w-]{22}$/);
  expect(victim.key).not.toContain(victim.secret.slice(0, 10));
  g.take();
  // A co-tenant that copies the listed key as its secret gets another key, and its own row.
  const squatters = Array.from({ length: MAX_SOCKETS_PER_KEY }, () =>
    host("box", victim.key.padEnd(43, "x")),
  );
  expect(squatters.every((socket) => socket.closed === null)).toBe(true);
  expect(network.hosts().filter((h) => h.key === victim.key)).toEqual([
    { id: victim.id, name: "box", key: victim.key },
  ]);
  // The victim may still open its other sockets.
  for (let i = 1; i < MAX_SOCKETS_PER_KEY; i++) {
    expect(host("box", victim.secret).closed).toBeNull();
  }
  // The old hello shape, with a key and no secret, is refused.
  const old = connect(false);
  send(old, { type: "hello", role: "host", name: "box", key: victim.key });
  expect(old.closed).toEqual({ code: 1008, reason: "Invalid message" });
});

test("over NETWORK_HOST_RATE_LIMIT, every socket of the key that sent the most is closed", () => {
  const { send, guest, host } = setup();
  const g = guest();
  const secret = newSecret("flooder");
  const flooder = [host("a", secret), host("a", secret)];
  const busy = host("b");
  const quiet = host("c");
  for (let i = 0; i < HOST_RATE_LIMIT; i++) {
    send(flooder[i % 2]!, { type: "signal", to: g.id, data: OFFER });
  }
  for (let i = 0; i < NETWORK_HOST_RATE_LIMIT - HOST_RATE_LIMIT - 1; i++) {
    send(busy, { type: "signal", to: g.id, data: OFFER });
  }
  send(quiet, { type: "signal", to: g.id, data: OFFER });
  expect([...flooder, busy, quiet].every((socket) => socket.closed === null)).toBe(true);
  g.take();

  send(quiet, { type: "signal", to: g.id, data: OFFER });
  for (const socket of flooder) {
    expect(socket.take().at(-1)).toEqual(
      error("network-rate-limit", "Too many messages on this network"),
    );
    expect(socket.closed).toEqual({ code: 1013, reason: "Too many messages on this network" });
  }
  expect(quiet.closed).toBeNull();
  expect(g.take()).toContainEqual({ type: "signal", from: quiet.id, data: OFFER });
  // The flooder's messages stopped counting, exactly: the others may fill the budget again.
  const late = host("d");
  for (let i = 0; i < NETWORK_HOST_RATE_LIMIT - (HOST_RATE_LIMIT - 1) - 2; i++) {
    send(late, { type: "signal", to: g.id, data: OFFER });
  }
  expect(busy.closed ?? quiet.closed ?? late.closed).toBeNull();
  send(quiet, { type: "signal", to: g.id, data: OFFER });
  expect(busy.closed?.code).toBe(1013);
  expect(quiet.closed ?? late.closed).toBeNull();
});

test("hosts don't spend the guests' network budget, nor guests the hosts'", () => {
  const { send, guest, host } = setup();
  const g = guest();
  const hosts = [host(), host()];
  for (const h of hosts) {
    for (let i = 0; i < HOST_RATE_LIMIT; i++) send(h, { type: "signal", to: g.id, data: OFFER });
  }
  // 200 in all, with the hosts' hellos: a socket isn't a host's until it said hello.
  const guests = [g, ...Array.from({ length: 3 }, () => guest())];
  for (const [n, other] of guests.entries()) {
    for (let i = n ? 1 : 3; i < GUEST_RATE_LIMIT; i++) {
      send(other, { type: "signal", to: hosts[0]!.id, data: OFFER });
    }
  }
  expect([...hosts, ...guests].every((socket) => socket.closed === null)).toBe(true);
});

test("over NETWORK_RATE_LIMIT, the socket that sent the most is closed, not the sender", () => {
  const { clock, send, guest, host } = setup();
  const h = host(); // its hello counts: it wasn't a host yet
  // Once a host, it doesn't count toward the network's budget.
  for (let i = 1; i < HOST_RATE_LIMIT; i++) send(h, { type: "signal", to: "nobody", data: OFFER });
  const flooder = guest();
  for (let i = 1; i < 44; i++) send(flooder, { type: "signal", to: h.id, data: OFFER });
  const others = Array.from({ length: 5 }, () => guest());
  for (const g of others) {
    for (let i = 1; i < 31; i++) send(g, { type: "signal", to: h.id, data: OFFER });
  }
  expect(1 + 44 + 5 * 31).toBe(NETWORK_RATE_LIMIT);
  expect([h, flooder, ...others].every((socket) => socket.closed === null)).toBe(true);
  h.take();

  const [sender, next] = others;
  send(sender, { type: "signal", to: h.id, data: OFFER });
  expect(flooder.closed).toEqual({ code: 1013, reason: "Too many messages on this network" });
  expect(sender.closed).toBeNull();
  expect(h.take()).toEqual([{ type: "signal", from: sender.id, data: OFFER }]);
  // The flooder's messages stopped counting, so the others go on.
  for (let i = 0; i < 15; i++) send(next, { type: "signal", to: h.id, data: OFFER });
  expect(others.every((g) => g.closed === null)).toBe(true);
  expect(h.closed).toBeNull();

  clock.now += RATE_WINDOW;
  for (let i = 0; i < 40; i++) send(next, { type: "signal", to: h.id, data: OFFER });
  expect(next.closed).toBeNull();
});

test("over NETWORK_RATE_LIMIT, a sender that sent the most is closed and its message dropped", () => {
  const { send, guest, host } = setup();
  const h = host();
  const others = Array.from({ length: 4 }, () => guest());
  for (const g of others) {
    for (let i = 1; i < 39; i++) send(g, { type: "signal", to: h.id, data: OFFER });
  }
  const sender = guest();
  for (let i = 1; i < 43; i++) send(sender, { type: "signal", to: h.id, data: OFFER });
  expect(1 + 4 * 39 + 43).toBe(NETWORK_RATE_LIMIT);
  h.take();
  send(sender, { type: "signal", to: h.id, data: OFFER });
  expect(sender.closed).toEqual({ code: 1013, reason: "Too many messages on this network" });
  expect(h.take()).toEqual([]);
  expect(others.every((g) => g.closed === null)).toBe(true);
});

test("a pairing with trickled candidates, and a resume, stay well under the budget", () => {
  const { send, guest, host } = setup();
  const g = guest();
  const h = host();
  const candidate = {
    kind: "candidate",
    offerId: "offer-0123456789ab",
    candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host" },
  };
  for (let pairing = 0; pairing < 2; pairing++) {
    send(g, { type: "signal", to: h.id, data: { ...OFFER, resume: pairing === 1 } });
    send(h, {
      type: "signal",
      to: g.id,
      data: { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" },
    });
    for (let i = 0; i < 12; i++) {
      send(g, { type: "signal", to: h.id, data: candidate });
      send(h, { type: "signal", to: g.id, data: candidate });
    }
  }
  expect(g.closed).toBeNull();
  expect(h.closed).toBeNull();
});

test("a host pairs with 4 guests at once, 25 candidates each way, within the limits", () => {
  const { send, guest, host } = setup();
  const h = host();
  const guests = Array.from({ length: 4 }, () => guest());
  const candidate = {
    kind: "candidate",
    offerId: "offer-0123456789ab",
    candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host" },
  };
  const CANDIDATES = 25;
  for (const g of guests) send(g, { type: "signal", to: h.id, data: OFFER });
  for (const g of guests)
    send(h, {
      type: "signal",
      to: g.id,
      data: { kind: "answer", offerId: "offer-0123456789ab", sdp: "v=0" },
    });
  // Interleaved, as candidates trickle in from every pairing at once.
  for (let i = 0; i < CANDIDATES; i++) {
    for (const g of guests) {
      send(g, { type: "signal", to: h.id, data: candidate });
      send(h, { type: "signal", to: g.id, data: candidate });
    }
  }
  expect([h, ...guests].every((socket) => socket.closed === null)).toBe(true);
  expect(h.take()).toHaveLength(guests.length * (1 + CANDIDATES));
  for (const g of guests) {
    expect(g.take().filter((m) => m.type === "signal")).toHaveLength(1 + CANDIDATES);
  }
});

test("after hibernation, budgets start over and the attachments keep the rest", () => {
  const env = setup();
  const { clock, send, guest, host, connect, leave } = env;
  const first = host("box", newSecret("hibernating"));
  const g = guest();
  for (let i = 1; i < GUEST_RATE_LIMIT; i++) send(g, { type: "signal", to: first.id, data: OFFER });
  const silent = connect(false);
  clock.now += 1000;

  env.hibernate();
  // The guest's budget is new.
  send(g, { type: "signal", to: first.id, data: OFFER });
  expect(g.closed).toBeNull();
  // Join order comes from the attachments: the first socket of the key stays listed.
  const second = host("box", newSecret("hibernating"));
  expect(env.network.hosts()).toEqual([{ id: first.id, name: "box", key: first.key }]);
  leave(first);
  expect(env.network.hosts()).toEqual([{ id: second.id, name: "box", key: second.key }]);
  // The silent socket's `opened` is from before: it times out on schedule.
  clock.now += HELLO_TIMEOUT - 1000;
  expect(env.network.connect(true)).toHaveProperty("attachment");
  expect(silent.closed).toEqual({ code: 1008, reason: "Say hello first" });
});
