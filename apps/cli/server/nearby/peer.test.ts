// A real werift guest on loopback against a GuestSession: offer, answer, trickle, auth, a request.
import { afterEach, expect, test } from "bun:test";
import {
  AUTH_ATTEMPTS,
  authProof,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  parseChunk,
  sdpFingerprint,
} from "@gitui/shared";
import { RTCPeerConnection } from "werift";
import { expectedProof, newCode, parseAuth, proofChecker } from "./auth.ts";
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

/** Connects a guest to a new session; resolves once the guest's channel is open. */
async function connect({ label = DATA_CHANNEL_LABEL, authTimeout = 10_000 } = {}) {
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

  const code = () => /code (\d{6})$/.exec(log.join("\n"))?.[1] ?? "";
  await until(() => code() !== "");
  const proof = async (c: string) =>
    authProof(c, sdpFingerprint(offerSdp)!, sdpFingerprint(answerSdp)!);
  const send = (message: ChannelMessage) => channel.send(JSON.stringify(message));
  return {
    session,
    channel,
    received,
    log,
    code: code(),
    proof,
    send,
    get closed() {
      return closed;
    },
    get ended() {
      return ended;
    },
    opened: () => until(() => channel.readyState === "open"),
  };
}

const wrongCode = (code: string) => String((Number(code) + 1) % 1e6).padStart(6, "0");

test("the right code opens the bridge; requests are answered", async () => {
  const guest = await connect();
  expect(guest.log).toEqual([`Nearby: a device wants to connect — code ${guest.code}`]);
  await guest.opened();
  guest.send({ t: "auth", proof: await guest.proof(guest.code) });
  guest.send({ t: "req", id: 1, method: "GET", path: "/api/config", headers: [] });
  guest.send({ t: "end", id: 1 });
  await until(() => guest.received.length === 4);
  const [ok, res, body, end] = guest.received;
  expect(ok).toEqual({ t: "auth-ok" });
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

test(`a wrong code is refused ${AUTH_ATTEMPTS} times, then the channel closes`, async () => {
  const guest = await connect();
  await guest.opened();
  const wrong = await guest.proof(wrongCode(guest.code));
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
  guest.send({ t: "auth", proof: await authProof(guest.code, "sha-256 AA", "sha-256 BB") });
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
  const guest = await connect({ authTimeout: 300 });
  await until(() => guest.ended);
  expect(guest.log.at(-1)).toBe(`Nearby: code ${guest.code} expired`);
});

test("codes have AUTH_CODE_DIGITS digits; auth messages are parsed strictly", async () => {
  for (let i = 0; i < 100; i++) expect(newCode()).toMatch(/^\d{6}$/);
  expect(parseAuth('{"t":"auth","proof":"p"}')).toBe("p");
  for (const data of [
    '{"t":"auth"}',
    '{"t":"req","proof":"p"}',
    "nope",
    "null",
    new Uint8Array(1),
  ]) {
    expect(parseAuth(data)).toBeNull();
  }
  expect(await expectedProof("123456", "v=0", "v=0")).toBeNull();
  const check = proofChecker("right");
  expect(check("wrong")).toEqual({ ok: false, attemptsLeft: 2 });
  expect(check("right")).toEqual({ ok: true });
  expect(check("wrong")).toEqual({ ok: false, attemptsLeft: 1 });
  expect(check("wrong")).toEqual({ ok: false, attemptsLeft: 0 });
  expect(check("right")).toEqual({ ok: false, attemptsLeft: 0 });
});
