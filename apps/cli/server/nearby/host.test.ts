// startNearby on fake rendezvous sockets (one per IP family), with a real werift guest.
import { afterEach, expect, test } from "bun:test";
import {
  type ClientMessage,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  guestFinish,
  guestStart,
  HOST_KEY,
  hostKey,
  type HostMessage,
  MAX_OFFERS_PER_MINUTE,
  MAX_PENDING,
  MAX_REFUSALS_PER_WINDOW,
  newOfferId,
  resumeStart,
  sdpFingerprint,
  type SignalData,
} from "@gitui/shared";
import { RTCPeerConnection } from "werift";
import { type FakeSocket, fakeSockets } from "./fake-socket.ts";
import { lockoutLine, PAIRING_WINDOW } from "./auth.ts";
import { fakePeers, sdpWithPrint } from "./fake-peer.ts";
import { familiesFor, type NearbyOptions, startNearby } from "./host.ts";

const until = async (condition: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !condition(); t += 10) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
};

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const URL = "wss://rendezvous.example/v1/connect";

function host(options: Partial<NearbyOptions> = {}) {
  const fake = fakeSockets();
  const log: string[] = [];
  const nearby = startNearby({
    url: URL,
    name: "Desk",
    fetch: () => new Response("hi"),
    log: (line) => log.push(line),
    open: fake.open,
    backoff: { first: 10, max: 20 },
    statusDelay: 1000,
    ...options,
  });
  cleanup.push(() => nearby.stop());
  return { nearby, log, ...fake };
}

const welcome = (socket: FakeSocket, id: string) => {
  socket.open();
  socket.receive({ type: "welcome", id });
};

const signals = (socket: FakeSocket, to: string) =>
  socket.sent.filter((m) => m.type === "signal" && m.to === to);

test("IP literals in the rendezvous URL pin one family", () => {
  expect(familiesFor(URL)).toEqual([4, 6]);
  expect(familiesFor("ws://localhost:8787/v1/connect")).toEqual([4, 6]);
  expect(familiesFor("ws://127.0.0.1:8787/v1/connect")).toEqual([4]);
  expect(familiesFor("ws://[::1]:8787/v1/connect")).toEqual([6]);
});

test("the host registers over IPv4 and IPv6 with one secret and prints one line", async () => {
  const { nearby, log, last, sockets } = host();
  expect(nearby.key).toMatch(HOST_KEY);
  expect(sockets.map((s) => s.family)).toEqual([4, 6]);
  welcome(last(4)!, "a");
  expect(log).toEqual([]);
  welcome(last(6)!, "b");
  const [hello] = last(4)!.sent as [Extract<ClientMessage, { role: "host" }>];
  expect(hello).toEqual({ type: "hello", role: "host", name: "Desk", secret: expect.any(String) });
  expect(last(6)!.sent).toEqual([hello]);
  // Guests see the key, which the service derives from the secret the same way.
  expect(hostKey(hello.secret)).toBe(nearby.key);
  expect(log).toEqual([
    "Nearby: visible as 'Desk' (IPv4, IPv6) on this network — open https://gitui.diffiii.dev on your phone",
  ]);
});

test("a family that can't connect is retried quietly", async () => {
  const { log, last, sockets } = host();
  last(6)!.fail();
  welcome(last(4)!, "a");
  expect(log).toEqual([
    "Nearby: visible as 'Desk' (IPv4) on this network — open https://gitui.diffiii.dev on your phone",
  ]);
  for (let n = 2; n <= 4; n++) {
    await until(() => sockets.filter((s) => s.family === 6).length === n);
    last(6)!.fail();
  }
  welcome(last(6)!, "b");
  expect(log).toHaveLength(1);
});

test("the line waits for a slow family only so long", async () => {
  const { log, last } = host({ statusDelay: 50 });
  welcome(last(6)!, "b");
  await until(() => log.length === 1);
  expect(log[0]).toContain("(IPv6)");
});

test("losing every family is said once, and so is coming back", async () => {
  const { log, last, sockets } = host();
  welcome(last(4)!, "a");
  welcome(last(6)!, "b");
  last(4)!.fail();
  expect(log).toHaveLength(1);
  last(6)!.fail();
  expect(log.at(-1)).toBe("Nearby: lost the rendezvous service, reconnecting");
  await until(() => sockets.length >= 4);
  last(4)!.fail();
  welcome(last(6)!, "c");
  expect(log.slice(1)).toEqual([
    "Nearby: lost the rendezvous service, reconnecting",
    "Nearby: reconnected to the rendezvous service",
  ]);
});

test("an unreachable service is said once", async () => {
  const { log, last, sockets } = host();
  for (let n = 2; n <= 8; n += 2) {
    last(4)!.fail();
    last(6)!.fail();
    await until(() => sockets.length === n + 2);
  }
  expect(log).toEqual([`Nearby: can't reach the rendezvous service at ${URL}, retrying`]);
  welcome(last(4)!, "a");
  expect(log.at(-1)).toContain("visible as 'Desk' (IPv4)");
});

test("a refusal for want of room is said once per reason, not on every retry", async () => {
  const { log, last, sockets } = host();
  const refuse = (family: 4 | 6, code: "host-limit" | "key-limit") => {
    const socket = last(family)!;
    socket.open();
    socket.receive({ type: "error", code, message: "whatever the service says" });
    socket.fail();
  };
  welcome(last(6)!, "b");
  for (let n = 3; n <= 6; n++) {
    refuse(4, "host-limit");
    await until(() => sockets.length === n);
  }
  const noRoom = "Nearby: too many computers on this network use gitui nearby already, retrying";
  const stale =
    "Nearby: the rendezvous service still holds this computer's earlier connections, retrying";
  expect(log.filter((line) => line === noRoom)).toHaveLength(1);
  refuse(4, "key-limit");
  await until(() => sockets.length === 7);
  refuse(4, "key-limit");
  expect(log.filter((line) => line === stale)).toHaveLength(1);
  expect(log.filter((line) => line.includes("reported"))).toEqual([]);
  // After a welcome, a new refusal is said again.
  await until(() => sockets.length === 8);
  welcome(last(4)!, "a");
  last(4)!.fail();
  await until(() => sockets.length === 9);
  refuse(4, "host-limit");
  expect(log.filter((line) => line === noRoom)).toHaveLength(2);
});

test("other errors from the service are printed with their code", () => {
  const { log, last } = host();
  welcome(last(4)!, "a");
  last(4)!.receive({ type: "error", code: "rate-limit", message: "Too many\u001b[2J messages" });
  expect(log.at(-1)).toBe(
    "Nearby: the rendezvous service reported: Too many[2J messages (rate-limit)",
  );
});

test("a session is bound to the socket its offer came on", async () => {
  const { log, last } = host();
  const v4 = last(4)!;
  const v6 = last(6)!;
  welcome(v4, "h4");
  welcome(v6, "h6");

  // A guest whose id on the IPv6 socket is "g1"; another peer on IPv4 has the same id.
  const pc = new RTCPeerConnection({ iceServers: [] });
  cleanup.push(() => pc.close());
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
  const received: ChannelMessage[] = [];
  channel.onmessage = ({ data }) => received.push(JSON.parse(String(data)) as ChannelMessage);
  const offerId = "offer-0123456789ab";
  let closed = false;
  channel.stateChanged.subscribe((state) => {
    if (state === "closed") closed = true;
  });
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      const data: SignalData = { kind: "candidate", offerId, candidate: candidate.toJSON() };
      v6.receive({ type: "signal", from: "g1", data });
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription!.sdp;
  v6.receive({ type: "signal", from: "g1", data: { kind: "offer", offerId, sdp: offerSdp } });

  // Its answer and candidates go back on the IPv6 socket only.
  await until(() => signals(v6, "g1").some((m) => m.type === "signal" && m.data.kind === "answer"));
  let answerSdp = "";
  let applied = 0;
  const apply = async () => {
    for (const message of signals(v6, "g1").slice(applied)) {
      applied++;
      if (message.type !== "signal") continue;
      if (message.data.kind === "answer") {
        answerSdp = message.data.sdp;
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } else if (message.data.kind === "candidate")
        await pc.addIceCandidate(message.data.candidate);
    }
  };
  await apply();
  const trickle = setInterval(() => void apply(), 20);
  cleanup.push(() => clearInterval(trickle));
  await until(() => channel.readyState === "open");
  expect(signals(v4, "g1")).toEqual([]);

  const code = await (async () => {
    await until(() => log.some((line) => /code \d{6}$/.test(line)));
    return /code (\d{6})$/.exec(log.join("\n"))![1];
  })();
  const prints = { guest: sdpFingerprint(offerSdp)!, host: sdpFingerprint(answerSdp)! };
  const start = guestStart(code, prints);
  channel.send(JSON.stringify(start.message));
  await until(() => received.length === 1);
  const confirm = guestFinish(start.state, received[0] as Extract<HostMessage, { t: "pake" }>);
  expect(confirm).not.toBeNull();
  channel.send(JSON.stringify(confirm));
  await until(() => received.length === 3);
  expect(received[1]).toEqual({ t: "auth-ok" });

  // `gone` for "g1" on the other socket is another peer: the session stays.
  v4.receive({ type: "gone", id: "g1" });
  await new Promise((r) => setTimeout(r, 100));
  expect(closed).toBe(false);

  // On its own socket, it ends the session.
  v6.receive({ type: "gone", id: "g1" });
  await until(() => log.at(-1) === "Nearby: device disconnected");
  await until(() => closed);
});

test("an offer that says it resumes prints no code until its resume fails", async () => {
  const { log, last } = host();
  const v4 = last(4)!;
  welcome(v4, "h4");
  const pc = new RTCPeerConnection({ iceServers: [] });
  cleanup.push(() => pc.close());
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
  const received: ChannelMessage[] = [];
  channel.onmessage = ({ data }) => received.push(JSON.parse(String(data)) as ChannelMessage);
  const offerId = "offer-0123456789ab";
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      v4.receive({
        type: "signal",
        from: "g1",
        data: { kind: "candidate", offerId, candidate: candidate.toJSON() },
      });
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription!.sdp;
  // As the rendezvous relays it: JSON text, parsed by the host's own reader.
  v4.receive({
    type: "signal",
    from: "g1",
    data: { kind: "offer", offerId, sdp: offerSdp, resume: true },
  });
  let answerSdp = "";
  let applied = 0;
  const trickle = setInterval(() => {
    for (const message of signals(v4, "g1").slice(applied)) {
      applied++;
      if (message.type !== "signal") continue;
      if (message.data.kind === "answer") {
        answerSdp = message.data.sdp;
        void pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } else if (message.data.kind === "candidate") void pc.addIceCandidate(message.data.candidate);
    }
  }, 20);
  cleanup.push(() => clearInterval(trickle));
  await until(() => channel.readyState === "open");
  await new Promise((r) => setTimeout(r, 200));
  expect(log.filter((line) => /code \d{6}$/.test(line))).toEqual([]);

  const prints = { guest: sdpFingerprint(offerSdp)!, host: sdpFingerprint(answerSdp)! };
  channel.send(JSON.stringify(resumeStart("unknown-token".padEnd(43, "x"), prints)));
  await until(() => received.length === 1);
  expect(received).toEqual([{ t: "auth-fail", attemptsLeft: 3 }]);
  await until(() => log.some((line) => /code \d{6}$/.test(line)));
});

test("offers over the limits are refused, with the reason", async () => {
  const { log, last } = host();
  const v4 = last(4)!;
  welcome(v4, "h4");
  const pc = new RTCPeerConnection({ iceServers: [] });
  cleanup.push(() => pc.close());
  pc.createDataChannel(DATA_CHANNEL_LABEL);
  await pc.setLocalDescription(await pc.createOffer());
  const sdp = pc.localDescription!.sdp;
  const offer = (from: string, offerId: string) =>
    v4.receive({ type: "signal", from, data: { kind: "offer", offerId, sdp } });
  const refusals = () =>
    v4.sent.flatMap((m) => (m.type === "signal" && m.data.kind === "refused" ? [m] : []));

  for (let i = 0; i < MAX_PENDING; i++) offer(`g${i}`, `offer-${i}`.padEnd(16, "x"));
  offer("busy", "offer-busy".padEnd(16, "x"));
  expect(refusals()).toEqual([
    {
      type: "signal",
      to: "busy",
      data: { kind: "refused", offerId: "offer-busy".padEnd(16, "x"), reason: "busy" },
    },
  ]);
  expect(log.at(-1)).toBe("Nearby: ignoring connection requests, too many at once");
  // The same guests sending new offers replace their sessions, until the minute's offers run out.
  for (let i = MAX_PENDING; i < MAX_OFFERS_PER_MINUTE; i++)
    offer("g0", `offer-${i}`.padEnd(16, "x"));
  offer("g0", "offer-late".padEnd(16, "x"));
  expect(refusals().at(-1)?.data).toEqual({
    kind: "refused",
    offerId: "offer-late".padEnd(16, "x"),
    reason: "rate-limited",
  });
});

test("a flood of offers gets at most MAX_REFUSALS_PER_WINDOW refusals", () => {
  const { last } = host();
  const v4 = last(4)!;
  welcome(v4, "h4");
  const sent = () => v4.sent.filter((m) => m.type === "signal").length;
  // MAX_PENDING are taken, and the rest refused as busy.
  for (let i = 0; i < MAX_PENDING + 3 * MAX_REFUSALS_PER_WINDOW; i++) {
    v4.receive({
      type: "signal",
      from: `g${i}`,
      data: { kind: "offer", offerId: `offer-${i}`.padEnd(16, "x"), sdp: "v=0" },
    });
  }
  // The sessions answer later (here: refuse as bad-offer); the limiter's refusals are sent now.
  expect(sent()).toBe(MAX_REFUSALS_PER_WINDOW);
});

test("an offer the host can't use is refused as such", async () => {
  const { log, last } = host();
  const v4 = last(4)!;
  welcome(v4, "h4");
  const offerId = "offer-bad-0123456789";
  v4.receive({ type: "signal", from: "g1", data: { kind: "offer", offerId, sdp: "v=0" } });
  await until(() => signals(v4, "g1").length > 0);
  expect(signals(v4, "g1")).toEqual([
    { type: "signal", to: "g1", data: { kind: "refused", offerId, reason: "bad-offer" } },
  ]);
  expect(log.at(-1)).toStartWith("Nearby: ");
});

test("the werift guard is on while nearby runs", async () => {
  const before = process.listenerCount("unhandledRejection");
  const { nearby } = host();
  expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  nearby.stop();
  expect(process.listenerCount("unhandledRejection")).toBe(before);
});

/** Offers from `from` on `socket`, with an SDP the fake peers can use. */
const offerOn = (socket: FakeSocket, from: string) =>
  socket.receive({
    type: "signal",
    from,
    data: { kind: "offer", offerId: newOfferId(), sdp: sdpWithPrint("cd") },
  });

const TEARDOWN_LINE = "Nearby: closed a connection after an error: Error: teardown failed";

test("a teardown that throws is logged, ends only its session, and drops no offer", async () => {
  // The connections of the first two offers throw when they are torn down.
  let n = 0;
  const fake = fakePeers({ closeThrows: () => n++ < 2 });
  const { log, last } = host({ peer: fake.peer });
  const v4 = last(4)!;
  welcome(v4, "h4");
  offerOn(v4, "a");
  offerOn(v4, "c");
  offerOn(v4, "b");
  await until(() => signals(v4, "b").length > 0);
  const [a, c, b] = fake.peers;

  // In an offer: replacing a's session throws; it ends, and the new offer is answered.
  offerOn(v4, "a");
  expect(log.at(-1)).toBe(TEARDOWN_LINE);
  expect(fake.peers).toHaveLength(4);
  await until(
    () =>
      signals(v4, "a").filter((m) => m.type === "signal" && m.data.kind === "answer").length === 2,
  );
  // In `gone`: likewise for c's.
  v4.receive({ type: "gone", id: "c" });
  expect(log.filter((l) => l === TEARDOWN_LINE)).toHaveLength(2);
  expect([a!.closed, c!.closed, b!.closed]).toEqual([true, true, false]);
  // Neither counts as pending any more: MAX_PENDING - 2 more guests get in besides a and b.
  for (let i = 2; i < MAX_PENDING; i++) offerOn(v4, `g${i}`);
  expect(fake.peers).toHaveLength(MAX_PENDING + 2);
  offerOn(v4, "busy");
  expect(signals(v4, "busy")).toMatchObject([{ data: { kind: "refused", reason: "busy" } }]);
});

test("stop closes every session and the guard, even if a teardown throws", async () => {
  const before = process.listenerCount("unhandledRejection");
  let n = 0;
  const fake = fakePeers({ closeThrows: () => n++ === 0 });
  const { nearby, log, last } = host({ peer: fake.peer });
  const v4 = last(4)!;
  welcome(v4, "h4");
  offerOn(v4, "a");
  offerOn(v4, "b");
  await until(() => signals(v4, "b").length > 0);
  nearby.stop();
  expect(fake.peers.map((peer) => peer.closed)).toEqual([true, true]);
  expect(log).toContain(TEARDOWN_LINE);
  expect(process.listenerCount("unhandledRejection")).toBe(before);
});

/** A werift guest that offers through `socket` as peer `from`, and trickles both ways. */
async function guestOn(socket: FakeSocket, from: string, { resume = false } = {}) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  cleanup.push(() => pc.close());
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
  const received: HostMessage[] = [];
  let closed = false;
  channel.onmessage = ({ data }) => received.push(JSON.parse(String(data)) as HostMessage);
  channel.stateChanged.subscribe((state) => {
    if (state === "closed") closed = true;
  });
  const offerId = newOfferId();
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    const data = { kind: "candidate", offerId, candidate: candidate.toJSON() } as const;
    socket.receive({ type: "signal", from, data });
  };
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription!.sdp;
  socket.receive({ type: "signal", from, data: { kind: "offer", offerId, sdp: offerSdp, resume } });
  let answerSdp = "";
  let applied = 0;
  const trickle = setInterval(() => {
    for (const message of signals(socket, from).slice(applied)) {
      applied++;
      if (message.type !== "signal") continue;
      if (message.data.kind === "answer") {
        answerSdp = message.data.sdp;
        void pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } else if (message.data.kind === "candidate") void pc.addIceCandidate(message.data.candidate);
    }
  }, 20);
  cleanup.push(() => clearInterval(trickle));
  await until(() => channel.readyState === "open");
  return {
    offerId,
    received,
    send: (message: object) => channel.send(JSON.stringify(message)),
    prints: () => ({ guest: sdpFingerprint(offerSdp)!, host: sdpFingerprint(answerSdp)! }),
    get closed() {
      return closed;
    },
  };
}

test("during a lockout, an offer that says it resumes but sends a pake is refused", async () => {
  const before = Date.now();
  const { log, last } = host({ pairingBudget: 1 });
  const v4 = last(4)!;
  welcome(v4, "h4");
  const codes = () => log.filter((line) => /code \d{6}$/.test(line));

  // The one attempt of the budget: a wrong code, answered.
  const first = await guestOn(v4, "a");
  await until(() => codes().length === 1);
  first.send(guestStart("000000", first.prints()).message);
  await until(() => first.received.length === 1);
  expect(first.received[0]).toMatchObject({ t: "pake" });
  const lockouts = log.filter((line) => line.includes("guessing codes"));
  expect(lockouts).toHaveLength(1);
  const until_ = [before, Date.now()].map((t) => lockoutLine(t + PAIRING_WINDOW));
  expect(until_).toContain(lockouts[0]);

  // An offer that doesn't resume is refused as such.
  const offerId = newOfferId();
  v4.receive({ type: "signal", from: "b", data: { kind: "offer", offerId, sdp: "v=0" } });
  expect(signals(v4, "b")).toEqual([
    { type: "signal", to: "b", data: { kind: "refused", offerId, reason: "pairing-locked" } },
  ]);

  // One that says it resumes gets a channel, and no code.
  const guest = await guestOn(v4, "b", { resume: true });
  // Garbage on the rendezvous socket: dropped, and the session stays.
  v4.receive("not json");
  v4.receive({ type: "signal", from: "b", data: { kind: "candidate", offerId: guest.offerId } });
  v4.receive({ type: "signal", from: "b", data: { kind: "nonsense", offerId: guest.offerId } });
  v4.receive({ type: "signal", from: "b", data: { kind: "refused", offerId, reason: "?" } });
  v4.receive({ type: "error", code: "from-the-future", message: "new\u0007 error" });
  expect(log.at(-1)).toBe("Nearby: the rendezvous service reported: new error (unknown)");
  expect(guest.closed).toBe(false);

  // It sends a pake instead of resuming: refused unanswered, and the channel closes.
  guest.send(guestStart("000000", guest.prints()).message);
  await until(() => guest.closed);
  expect(guest.received).toEqual([{ t: "auth-fail", attemptsLeft: 0 }]);
  expect(codes()).toHaveLength(1);
  expect(log.filter((line) => line.includes("guessing codes"))).toHaveLength(1);
});
