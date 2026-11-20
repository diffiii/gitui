// A real werift guest on loopback against a GuestSession: offer, answer, trickle, auth or
// resume, a request.
import { afterEach, expect, test } from "bun:test";
import {
  AUTH_ATTEMPTS,
  authProof,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  HOST_KEY,
  parseChunk,
  sdpFingerprint,
} from "@gitui/shared";
import { RTCPeerConnection } from "werift";
import {
  Attempts,
  findProof,
  fingerprints,
  MAX_TOKENS,
  newCode,
  newHostKey,
  newToken,
  parseOpening,
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
  const received: (ChannelMessage | Uint8Array)[] = [];
  let closed = false;
  channel.onmessage = ({ data }) =>
    received.push(typeof data === "string" ? (JSON.parse(data) as ChannelMessage) : data);
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
    stunUrls: [],
    authTimeout,
    resuming,
    tokens,
    signal: (data) => {
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
  pc.onicecandidate = ({ candidate }) => candidate && session.addCandidate(candidate.toJSON());

  await until(() => answerSdp !== "");
  /** The code the host printed, if it printed one. */
  const code = () => /code (\d{6})$/.exec(log.join("\n"))?.[1] ?? "";
  /** The proof of `secret` (a code or a token) for this connection. */
  const proof = (secret: string) =>
    authProof(secret, sdpFingerprint(offerSdp)!, sdpFingerprint(answerSdp)!);
  const send = (message: ChannelMessage) => channel.send(JSON.stringify(message));
  return {
    session,
    channel,
    received,
    log,
    code,
    proof,
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
  guest.send({ t: "auth", proof: await guest.proof(await guest.shownCode()) });
  await until(() => guest.received.length === 2);
  const [ok, session] = guest.received as ChannelMessage[];
  expect(ok).toEqual({ t: "auth-ok" });
  if (session.t !== "session") throw new Error(`expected a session, got ${session.t}`);
  return { guest, token: session.token };
}

test("the right code opens the bridge, hands out a token; requests are answered", async () => {
  const guest = await connect();
  await guest.opened();
  const code = await guest.shownCode();
  expect(guest.log).toEqual([`Nearby: a device wants to connect — code ${code}`]);
  guest.send({ t: "auth", proof: await guest.proof(code) });
  guest.send({ t: "req", id: 1, method: "GET", path: "/api/config", headers: [] });
  guest.send({ t: "end", id: 1 });
  await until(() => guest.received.length === 5);
  const [ok, session, res, body, end] = guest.received;
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

test("a live token resumes without a code, and keeps the token", async () => {
  const tokens = new Tokens();
  const { guest: first, token } = await pair(tokens);
  first.channel.close();
  await until(() => first.ended);

  const guest = await connect({ tokens, resuming: true });
  await guest.opened();
  guest.send({ t: "resume", proof: await guest.proof(token) });
  guest.send({ t: "req", id: 1, method: "GET", path: "/api/status", headers: [] });
  guest.send({ t: "end", id: 1 });
  await until(() => guest.received.length === 5);
  expect(guest.received.slice(0, 3)).toEqual([
    { t: "auth-ok" },
    { t: "session", token },
    expect.objectContaining({ t: "res", id: 1, status: 200 }),
  ]);
  expect(guest.session.authenticated).toBe(true);
  // No code, then or later.
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
  guest.send({ t: "resume", proof: await guest.proof(newToken()) });
  await until(() => guest.received.length === 1);
  expect(guest.received).toEqual([{ t: "auth-fail", attemptsLeft: AUTH_ATTEMPTS }]);
  const code = await guest.shownCode();

  guest.send({ t: "auth", proof: await guest.proof(code) });
  await until(() => guest.received.length === 3);
  const fresh = (guest.received[2] as { token: string }).token;
  expect(fresh).not.toBe(token);
  expect(tokens.list()).toEqual([token, fresh]);
  expect(guest.log.at(-1)).toBe("Nearby: device connected");
});

test(`after the first resume, resumes and codes share ${AUTH_ATTEMPTS} attempts`, async () => {
  const tokens = new Tokens();
  const { token } = await pair(tokens);
  const guest = await connect({ tokens, resuming: true });
  await guest.opened();
  guest.send({ t: "resume", proof: await guest.proof(newToken()) });
  guest.send({ t: "auth", proof: await guest.proof(wrongCode(await guest.shownCode())) });
  guest.send({ t: "resume", proof: await authProof(token, "sha-256 AA", "sha-256 BB") });
  guest.send({ t: "resume", proof: await guest.proof(newToken()) });
  // Too late: the attempts are spent.
  guest.send({ t: "resume", proof: await guest.proof(token) });
  await until(() => guest.ended && guest.closed);
  expect(guest.received).toEqual([
    { t: "auth-fail", attemptsLeft: 3 },
    { t: "auth-fail", attemptsLeft: 2 },
    { t: "auth-fail", attemptsLeft: 1 },
    { t: "auth-fail", attemptsLeft: 0 },
  ]);
  expect(guest.session.authenticated).toBe(false);
});

test(`a wrong code is refused ${AUTH_ATTEMPTS} times, then the channel closes`, async () => {
  const guest = await connect();
  await guest.opened();
  const wrong = await guest.proof(wrongCode(await guest.shownCode()));
  for (let i = 0; i < AUTH_ATTEMPTS; i++) guest.send({ t: "auth", proof: wrong });
  await until(() => guest.ended && guest.closed);
  expect(guest.received).toEqual([
    { t: "auth-fail", attemptsLeft: 2 },
    { t: "auth-fail", attemptsLeft: 1 },
    { t: "auth-fail", attemptsLeft: 0 },
  ]);
  expect(guest.log.at(-1)).toBe("Nearby: refused a device that entered a wrong code 3 times");
});

test("a proof bound to other fingerprints fails, even with the right code", async () => {
  const guest = await connect();
  await guest.opened();
  const code = await guest.shownCode();
  guest.send({ t: "auth", proof: await authProof(code, "sha-256 AA", "sha-256 BB") });
  await until(() => guest.received.length === 1);
  expect(guest.received).toEqual([{ t: "auth-fail", attemptsLeft: 2 }]);
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

test("keys, tokens and codes have their formats; openings are parsed strictly", () => {
  for (let i = 0; i < 100; i++) expect(newCode()).toMatch(/^\d{6}$/);
  expect(newHostKey()).toMatch(HOST_KEY);
  expect(newHostKey()).toHaveLength(22);
  expect(newToken()).toMatch(/^[\w-]{43}$/);
  expect(newHostKey()).not.toBe(newHostKey());

  expect(parseOpening('{"t":"auth","proof":"p"}')).toEqual({ t: "auth", proof: "p" });
  expect(parseOpening('{"t":"resume","proof":"p"}')).toEqual({ t: "resume", proof: "p" });
  for (const data of [
    '{"t":"auth"}',
    '{"t":"resume","proof":1}',
    '{"t":"req","proof":"p"}',
    "nope",
    "null",
    new Uint8Array(1),
  ]) {
    expect(parseOpening(data)).toBeNull();
  }
  expect(fingerprints("v=0", "v=0")).toBeNull();
});

test("attempts run out; proofs are found among many; tokens are capped", () => {
  const attempts = new Attempts();
  expect(attempts.check(false)).toEqual({ ok: false, attemptsLeft: 2 });
  expect(attempts.check(true)).toEqual({ ok: true });
  expect(attempts.check(false)).toEqual({ ok: false, attemptsLeft: 1 });
  expect(attempts.check(false)).toEqual({ ok: false, attemptsLeft: 0 });
  expect(attempts.check(true)).toEqual({ ok: false, attemptsLeft: 0 });

  expect(findProof("b", ["a", "b", "c"])).toBe(1);
  expect(findProof("d", ["a", "b", "c"])).toBe(-1);
  expect(findProof("a", [])).toBe(-1);

  const tokens = new Tokens();
  const first = tokens.issue();
  for (let i = 0; i < MAX_TOKENS; i++) tokens.issue();
  expect(tokens.list()).toHaveLength(MAX_TOKENS);
  expect(tokens.list()).not.toContain(first);
});
