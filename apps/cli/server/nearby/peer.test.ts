// A real werift guest on loopback against a GuestSession: offer, answer, trickle, CPace or
// resume, a request.
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  AUTH_ATTEMPTS,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  type Fingerprints,
  type GuestMessage,
  HOST_KEY,
  HOST_SECRET,
  hostKey,
  type HostMessage,
  MAX_LOCAL_CANDIDATES,
  parseChunk,
  sdpFingerprint,
} from "@gitui/shared";
import { guestFinish, guestStart, resumeStart, resumeVerify } from "@gitui/shared/nearby-pake";
import { RTCPeerConnection } from "werift";
import {
  fingerprints,
  MAX_TOKENS,
  newCode,
  newHostSecret,
  newToken,
  PairingBudget,
  Tokens,
} from "./auth.ts";
import { Bridge } from "./bridge.ts";
import { fakePeers, sdpWithPrint } from "./fake-peer.ts";
import { GuestSession, type GuestOptions, MAX_REMOTE_CANDIDATES } from "./peer.ts";

const sessions: GuestSession[] = [];
const peers: RTCPeerConnection[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(peers.splice(0).map((pc) => pc.close()));
});

const until = async (condition: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !condition(); t += 10) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFFER_ID = "offer-0123456789ab";
/** A fingerprint neither side has. */
const otherPrint = sdpFingerprint(`a=fingerprint:sha-256 ${"00:".repeat(31)}00`)!;

/** Connects a guest to a new session; resolves once the host answered. */
async function connect({
  label = DATA_CHANNEL_LABEL,
  authTimeout = 10_000,
  tokens = new Tokens(),
  budget = new PairingBudget(),
  resuming = false,
} = {}) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  peers.push(pc);
  const channel = pc.createDataChannel(label);
  const received: (HostMessage | Uint8Array)[] = [];
  let closed = false;
  channel.onmessage = ({ data }) =>
    received.push(typeof data === "string" ? (JSON.parse(data) as HostMessage) : data);
  channel.stateChanged.subscribe((state) => {
    if (state === "closed") closed = true;
  });
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription!.sdp;

  const log: string[] = [];
  let ended = false;
  let answerSdp = "";
  const session = new GuestSession({
    offerSdp,
    offerId: OFFER_ID,
    stunUrls: [],
    authTimeout,
    resuming,
    tokens,
    budget,
    signal: (data) => {
      expect(data.offerId).toBe(OFFER_ID);
      if (data.kind === "answer") {
        answerSdp = data.sdp;
        void pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      } else if (data.kind === "candidate") void pc.addIceCandidate(data.candidate);
    },
    fetch: (req) => Response.json({ path: new URL(req.url).pathname }),
    log: (line) => log.push(line),
    onEnd: () => {
      ended = true;
    },
  });
  sessions.push(session);
  pc.onicecandidate = ({ candidate }) =>
    candidate && session.addCandidate(OFFER_ID, candidate.toJSON());

  await until(() => answerSdp !== "");
  /** The code the host printed, if it printed one. */
  const code = () => /code (\d{6})$/.exec(log.join("\n"))?.[1] ?? "";
  /** This connection's fingerprints, as the guest sees them. */
  const prints = (): Fingerprints => ({
    guest: sdpFingerprint(offerSdp)!,
    host: sdpFingerprint(answerSdp)!,
  });
  const send = (message: GuestMessage | ChannelMessage) => channel.send(JSON.stringify(message));
  /** The next message from the host, after the `count` received so far. */
  const next = async (count = received.length) => {
    await until(() => received.length > count);
    return received[count] as HostMessage;
  };
  /**
   * One CPace run for `code` (bound to `as`, this connection's fingerprints by default): sends
   * `pake`, checks the host's answer, and sends `pake-confirm`, or `pake-fail` if it didn't
   * check out. Resolves with whether it did.
   */
  const pake = async (code: string, as = prints()) => {
    const start = guestStart(code, as);
    const count = received.length;
    send(start.message);
    const answer = await next(count);
    if (answer.t !== "pake") throw new Error(`expected a pake answer, got ${answer.t}`);
    const confirm = guestFinish(start.state, answer);
    send(confirm ?? { t: "pake-fail" });
    return confirm !== null;
  };
  return {
    session,
    channel,
    received,
    log,
    code,
    prints,
    pake,
    next,
    send,
    get closed() {
      return closed;
    },
    get ended() {
      return ended;
    },
    opened: () => until(() => channel.readyState === "open"),
    /** Waits for the code: the host prints it when the channel opens, or a resume failed. */
    shownCode: async () => {
      await until(() => code() !== "");
      return code();
    },
  };
}

const wrongCode = (code: string) => String((Number(code) + 1) % 1e6).padStart(6, "0");

/** Pairs a guest with its code and returns the token the host handed out. */
async function pair(tokens: Tokens) {
  const guest = await connect({ tokens });
  await guest.opened();
  expect(await guest.pake(await guest.shownCode())).toBe(true);
  await until(() => guest.received.length === 3);
  const [, ok, session] = guest.received as HostMessage[];
  expect(ok).toEqual({ t: "auth-ok" });
  if (session.t !== "session") throw new Error(`expected a session, got ${session.t}`);
  return { guest, token: session.token };
}

test("the right code opens the bridge, hands out a token; requests are answered", async () => {
  const guest = await connect();
  await guest.opened();
  const code = await guest.shownCode();
  expect(guest.log).toEqual([`Nearby: a device wants to connect — code ${code}`]);
  expect(await guest.pake(code)).toBe(true);
  guest.send({ t: "req", id: 1, method: "GET", path: "/api/config", headers: [] });
  guest.send({ t: "end", id: 1 });
  await until(() => guest.received.length === 6);
  const [answer, ok, session, res, body, end] = guest.received;
  expect(answer).toMatchObject({ t: "pake" });
  expect(ok).toEqual({ t: "auth-ok" });
  expect(session).toMatchObject({ t: "session" });
  expect((session as { token: string }).token).toMatch(/^[\w-]{43}$/);
  expect(res).toMatchObject({ t: "res", id: 1, status: 200 });
  expect(JSON.parse(Buffer.from(parseChunk(body as Uint8Array).payload).toString())).toEqual({
    path: "/api/config",
  });
  expect(end).toEqual({ t: "end", id: 1 });
  expect(guest.session.authenticated).toBe(true);
  expect(guest.log.at(-1)).toBe("Nearby: device connected");

  guest.channel.close();
  await until(() => guest.ended);
  expect(guest.log.at(-1)).toBe("Nearby: device disconnected");
});

test("a live token resumes without a code; the host proves it holds the token too", async () => {
  const tokens = new Tokens();
  const { guest: first, token } = await pair(tokens);
  first.channel.close();
  await until(() => first.ended);

  const guest = await connect({ tokens, resuming: true });
  await guest.opened();
  const resume = resumeStart(token, guest.prints());
  guest.send(resume);
  guest.send({ t: "req", id: 1, method: "GET", path: "/api/status", headers: [] });
  guest.send({ t: "end", id: 1 });
  await until(() => guest.received.length === 4);
  const [ok, res] = guest.received as HostMessage[];
  if (ok.t !== "resume-ok") throw new Error(`expected resume-ok, got ${ok.t}`);
  expect(resumeVerify(token, guest.prints(), resume, ok)).toBe(true);
  expect(res).toMatchObject({ t: "res", id: 1, status: 200 });
  expect(guest.session.authenticated).toBe(true);
  // No code, then or later, and no new token.
  await sleep(100);
  expect(guest.log).toEqual(["Nearby: a device reconnected"]);
  expect(tokens.list()).toEqual([token]);
});

test("a refused resume costs no attempt and shows the code, which still works", async () => {
  const tokens = new Tokens();
  const { token } = await pair(tokens);
  const guest = await connect({ tokens, resuming: true });
  const session = sessions.at(-1)!;
  await guest.opened();
  // A guest that said it would resume sees no code until its resume fails.
  await sleep(100);
  expect(guest.code()).toBe("");
  expect(session.resuming).toBe(true);
  guest.send(resumeStart(newToken(), guest.prints()));
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: AUTH_ATTEMPTS });
  const code = await guest.shownCode();
  // Showing a code makes it a code session, which frees its resume slot.
  expect(session.resuming).toBe(false);

  expect(await guest.pake(code)).toBe(true);
  await until(() => guest.received.length === 4);
  const fresh = (guest.received[3] as { token: string }).token;
  expect(fresh).not.toBe(token);
  expect(tokens.list()).toEqual([token, fresh]);
  expect(guest.log.at(-1)).toBe("Nearby: device connected");
});

test(`after the first resume, resumes and codes share ${AUTH_ATTEMPTS} attempts`, async () => {
  const tokens = new Tokens();
  const { token } = await pair(tokens);
  const guest = await connect({ tokens, resuming: true });
  await guest.opened();
  guest.send(resumeStart(newToken(), guest.prints()));
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: 3 });
  expect(await guest.pake(wrongCode(await guest.shownCode()))).toBe(false);
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: 2 });
  // The right token, proven for another connection.
  guest.send(resumeStart(token, { guest: guest.prints().guest, host: otherPrint }));
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: 1 });
  guest.send(resumeStart(newToken(), guest.prints()));
  // Too late: the attempts are spent.
  guest.send(resumeStart(token, guest.prints()));
  await until(() => guest.ended && guest.closed);
  expect(guest.received.slice(4)).toEqual([{ t: "auth-fail", attemptsLeft: 0 }]);
  expect(guest.session.authenticated).toBe(false);
});

test(`a wrong code is refused ${AUTH_ATTEMPTS} times, then the channel closes`, async () => {
  const guest = await connect();
  await guest.opened();
  const wrong = wrongCode(await guest.shownCode());
  for (let left = AUTH_ATTEMPTS - 1; left >= 0; left--) {
    // The host answers each run; the guest finds its tag wrong and says so.
    expect(await guest.pake(wrong)).toBe(false);
    expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: left });
  }
  await until(() => guest.ended && guest.closed);
  expect(guest.log.at(-1)).toBe("Nearby: refused a device that entered a wrong code 3 times");
});

test("a run bound to other fingerprints fails, even with the right code", async () => {
  const guest = await connect();
  await guest.opened();
  const code = await guest.shownCode();
  // A guest behind a relay that swapped the offer's certificate sees another fingerprint than
  // the host does. (Not a swap of the two: werift uses one certificate per process, so here
  // both sides have the same one.)
  const relayed = { ...guest.prints(), guest: otherPrint };
  expect(await guest.pake(code, relayed)).toBe(false);
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: 2 });
  // The same channel still takes the right code.
  expect(await guest.pake(code)).toBe(true);
  expect(await guest.next()).toEqual({ t: "auth-ok" });
});

test("a guest tag that doesn't check out is a failed attempt", async () => {
  const guest = await connect();
  await guest.opened();
  const code = await guest.shownCode();
  guest.send(guestStart(code, guest.prints()).message);
  expect(await guest.next()).toMatchObject({ t: "pake" });
  guest.send({ t: "pake-confirm", confirm: "A".repeat(43) });
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: 2 });
  expect(guest.session.authenticated).toBe(false);
});

test("a confirmation without a run breaks the protocol", async () => {
  const guest = await connect();
  await guest.opened();
  guest.send({ t: "pake-confirm", confirm: "A".repeat(43) });
  await until(() => guest.ended && guest.closed);
  expect(guest.received).toEqual([]);
  expect(guest.log.at(-1)).toBe("Nearby: a device broke the pairing protocol");
});

test("a request before the code ends the session unanswered", async () => {
  const guest = await connect();
  await guest.opened();
  guest.send({ t: "req", id: 1, method: "GET", path: "/api/config", headers: [] });
  await until(() => guest.ended && guest.closed);
  expect(guest.received).toEqual([]);
  expect(guest.log.at(-1)).toBe("Nearby: a device sent requests before its code");
});

test("a channel with another label ends the session", async () => {
  const guest = await connect({ label: "other" });
  await until(() => guest.ended);
  expect(guest.session.authenticated).toBe(false);
});

test("the code expires", async () => {
  const guest = await connect({ authTimeout: 400 });
  const code = await guest.shownCode();
  await until(() => guest.ended);
  expect(guest.log.at(-1)).toBe(`Nearby: code ${code} expired`);
});

test("secrets, keys, tokens and codes have their formats", () => {
  for (let i = 0; i < 100; i++) expect(newCode()).toMatch(/^\d{6}$/);
  const secret = newHostSecret();
  expect(secret).toMatch(HOST_SECRET);
  expect(secret).toHaveLength(43);
  expect(hostKey(secret)).toMatch(HOST_KEY);
  expect(hostKey(secret)).toHaveLength(22);
  expect(newToken()).toMatch(/^[\w-]{43}$/);
  expect(newHostSecret()).not.toBe(newHostSecret());

  expect(fingerprints("v=0", "v=0")).toBeNull();
});

test("the pairing budget spans sessions; once out, a pake is refused unanswered", async () => {
  const lines: string[] = [];
  const budget = new PairingBudget({ limit: 2, onLockout: () => lines.push("out") });
  const first = await connect({ budget });
  await first.opened();
  expect(await first.pake(wrongCode(await first.shownCode()))).toBe(false);
  expect(await first.next()).toEqual({ t: "auth-fail", attemptsLeft: 2 });

  // A new connection gets new attempts, but not a new budget.
  const second = await connect({ budget });
  await second.opened();
  const code = await second.shownCode();
  expect(await second.pake(code)).toBe(true);
  expect(await second.next()).toEqual({ t: "auth-ok" });
  expect(lines).toEqual(["out"]);

  // Even the right code gets no answer now.
  first.send(guestStart(first.code(), first.prints()).message);
  await until(() => first.ended && first.closed);
  expect(first.received.at(-1)).toEqual({ t: "auth-fail", attemptsLeft: 0, locked: true });
  expect(first.received.filter((m) => !(m instanceof Uint8Array) && m.t === "pake")).toHaveLength(
    1,
  );
  // The budget's line said why; the session adds none.
  expect(first.log.at(-1)).toMatch(/code \d{6}$/);
});

test("with the budget out, a failed first resume is refused without showing the code", async () => {
  const budget = new PairingBudget({ limit: 1 });
  budget.spend();
  const guest = await connect({ budget, resuming: true });
  await guest.opened();
  guest.send(resumeStart(newToken(), guest.prints()));
  await until(() => guest.ended && guest.closed);
  expect(guest.received).toEqual([{ t: "auth-fail", attemptsLeft: 0, locked: true }]);
  expect(guest.code()).toBe("");
});

test("tokens are capped", () => {
  const tokens = new Tokens();
  const first = tokens.issue();
  for (let i = 0; i < MAX_TOKENS; i++) tokens.issue();
  expect(tokens.list()).toHaveLength(MAX_TOKENS);
  expect(tokens.list()).not.toContain(first);
});

/** A session on a fake peer: what it signals and logs, and whether it ended. */
async function fakeSession(options: Partial<GuestOptions> = {}) {
  const signals: Parameters<GuestOptions["signal"]>[0][] = [];
  const log: string[] = [];
  let ended = 0;
  const session = new GuestSession({
    offerSdp: sdpWithPrint("cd"),
    offerId: OFFER_ID,
    stunUrls: [],
    tokens: new Tokens(),
    budget: new PairingBudget(),
    signal: (data) => signals.push(data),
    fetch: () => new Response(),
    log: (line) => log.push(line),
    onEnd: () => ended++,
    ...options,
  });
  sessions.push(session);
  await until(() => signals.length > 0);
  return {
    session,
    signals,
    log,
    get ended() {
      return ended;
    },
  };
}

test("candidates are capped each way, and a guest's for another offer are dropped", async () => {
  const fake = fakePeers();
  const { session, signals } = await fakeSession({ peer: fake.peer });
  const [peer] = fake.peers;
  const candidate = (n: number) => ({ candidate: `candidate:${n}`, sdpMid: "0", sdpMLineIndex: 0 });
  for (let n = 0; n < MAX_LOCAL_CANDIDATES + 5; n++) peer!.events.candidate(candidate(n));
  expect(signals.filter((s) => s.kind === "candidate")).toHaveLength(MAX_LOCAL_CANDIDATES);

  session.addCandidate("offer-of-another-time", candidate(-1));
  for (let n = 0; n < MAX_REMOTE_CANDIDATES + 5; n++) session.addCandidate(OFFER_ID, candidate(n));
  await sleep(10);
  expect(peer!.added).toEqual([...Array(MAX_REMOTE_CANDIDATES).keys()].map(candidate));
});

test("a session whose teardown throws still ends, says why, and doesn't throw", async () => {
  const fake = fakePeers({ closeThrows: () => true });
  const guest = await fakeSession({ peer: fake.peer });
  // As werift reports an error in one of the session's callbacks (webrtc.ts).
  fake.peers[0]!.events.error(new Error("boom"));
  expect(guest.ended).toBe(1);
  expect(guest.log).toEqual([
    "Nearby: closed a connection after an error: Error: teardown failed",
    "Nearby: closed a connection after an error: Error: boom",
  ]);
  guest.session.close();
  expect(guest.ended).toBe(1);
});

test("a bridge whose close throws still lets the channel and the peer close", async () => {
  const fake = fakePeers();
  const tokens = new Tokens();
  const token = tokens.issue();
  const guest = await fakeSession({ peer: fake.peer, tokens });
  let closed = false;
  let receive: (data: string) => void = () => {};
  fake.peers[0]!.events.channel({
    label: DATA_CHANNEL_LABEL,
    bufferedAmount: 0,
    send() {},
    drain: async () => {},
    listen: ({ message }) => (receive = message),
    close: () => (closed = true),
  });
  const prints = fingerprints(sdpWithPrint("cd"), sdpWithPrint("ab"))!;
  receive(JSON.stringify(resumeStart(token, prints)));
  expect(guest.session.authenticated).toBe(true);
  const bridgeClose = spyOn(Bridge.prototype, "close").mockImplementation(() => {
    throw new Error("bridge failed");
  });
  try {
    guest.session.close();
  } finally {
    bridgeClose.mockRestore();
  }
  expect([closed, fake.peers[0]!.closed, guest.ended]).toEqual([true, true, 1]);
  expect(guest.log.slice(-2)).toEqual([
    "Nearby: closed a connection after an error: Error: bridge failed",
    "Nearby: device disconnected",
  ]);
});

test("an error in a callback werift calls closes the session, through PeerEvents.error", async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  peers.push(pc);
  pc.createDataChannel(DATA_CHANNEL_LABEL);
  await pc.setLocalDescription(await pc.createOffer());
  const log: string[] = [];
  let ended = false;
  const session = new GuestSession({
    offerSdp: pc.localDescription!.sdp,
    offerId: OFFER_ID,
    stunUrls: [],
    tokens: new Tokens(),
    budget: new PairingBudget(),
    // werift trickles this side's candidates from its own code.
    signal: (data) => {
      if (data.kind === "candidate") throw new Error("boom");
    },
    fetch: () => new Response(),
    log: (line) => log.push(line),
    onEnd: () => {
      ended = true;
    },
  });
  sessions.push(session);
  await until(() => ended);
  await sleep(50);
  expect(log).toEqual(["Nearby: closed a connection after an error: Error: boom"]);
});
