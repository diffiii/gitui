// A real werift guest on loopback against a GuestSession: offer, answer, trickle, CPace or
// resume, a request.
import { afterEach, expect, test } from "bun:test";
import {
  AUTH_ATTEMPTS,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  type Fingerprints,
  type GuestMessage,
  guestFinish,
  guestStart,
  HOST_KEY,
  type HostMessage,
  parseChunk,
  resumeStart,
  resumeVerify,
  sdpFingerprint,
} from "@gitui/shared";
import { RTCPeerConnection } from "werift";
import {
  Attempts,
  fingerprints,
  MAX_TOKENS,
  newCode,
  newHostKey,
  newToken,
  Tokens,
} from "./auth.ts";
import { GuestSession } from "./peer.ts";

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

/** Connects a guest to a new session; resolves once the host answered. */
async function connect({
  label = DATA_CHANNEL_LABEL,
  authTimeout = 10_000,
  tokens = new Tokens(),
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
  await guest.opened();
  // A guest that said it would resume sees no code until its resume fails.
  await sleep(100);
  expect(guest.code()).toBe("");
  guest.send(resumeStart(newToken(), guest.prints()));
  expect(await guest.next()).toEqual({ t: "auth-fail", attemptsLeft: AUTH_ATTEMPTS });
  const code = await guest.shownCode();

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
  guest.send(resumeStart(token, { guest: guest.prints().guest, host: "sha-256 00" }));
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
  const relayed = { ...guest.prints(), guest: `sha-256 ${"00:".repeat(31)}00` };
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

test("keys, tokens and codes have their formats", () => {
  for (let i = 0; i < 100; i++) expect(newCode()).toMatch(/^\d{6}$/);
  expect(newHostKey()).toMatch(HOST_KEY);
  expect(newHostKey()).toHaveLength(22);
  expect(newToken()).toMatch(/^[\w-]{43}$/);
  expect(newHostKey()).not.toBe(newHostKey());

  expect(fingerprints("v=0", "v=0")).toBeNull();
});

test("attempts run out; tokens are capped", () => {
  const attempts = new Attempts();
  expect(attempts.check(false)).toEqual({ ok: false, attemptsLeft: 2 });
  expect(attempts.check(true)).toEqual({ ok: true });
  expect(attempts.check(false)).toEqual({ ok: false, attemptsLeft: 1 });
  expect(attempts.check(false)).toEqual({ ok: false, attemptsLeft: 0 });
  expect(attempts.check(true)).toEqual({ ok: false, attemptsLeft: 0 });

  const spent = new Attempts();
  expect(spent.spend()).toBe(2);
  expect(spent.check(true)).toEqual({ ok: true });
  expect(spent.spend()).toBe(1);
  expect(spent.spend()).toBe(0);
  expect(spent.spend()).toBe(0);

  const tokens = new Tokens();
  const first = tokens.issue();
  for (let i = 0; i < MAX_TOKENS; i++) tokens.issue();
  expect(tokens.list()).toHaveLength(MAX_TOKENS);
  expect(tokens.list()).not.toContain(first);
});
