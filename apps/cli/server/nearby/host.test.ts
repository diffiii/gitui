// startNearby on fake rendezvous sockets (one per IP family), with a real werift guest.
import { afterEach, expect, test } from "bun:test";
import {
  authProof,
  type ClientMessage,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  HOST_KEY,
  sdpFingerprint,
  type SignalData,
} from "@gitui/shared";
import { RTCPeerConnection } from "werift";
import { type FakeSocket, fakeSockets } from "./fake-socket.ts";
import { familiesFor, rendezvousUrl, startNearby } from "./host.ts";

const until = async (condition: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !condition(); t += 10) await new Promise((r) => setTimeout(r, 10));
  expect(condition()).toBe(true);
};

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const URL = "wss://rendezvous.example/v1/connect";

function host({ statusDelay = 1000 } = {}) {
  const fake = fakeSockets();
  const log: string[] = [];
  const nearby = startNearby({
    url: URL,
    name: "Desk",
    fetch: () => new Response("hi"),
    log: (line) => log.push(line),
    open: fake.open,
    backoff: { first: 10, max: 20 },
    statusDelay,
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

test("rendezvous URLs are ws: or wss: origins; IP literals pin one family", () => {
  expect(rendezvousUrl("wss://rendezvous.example")).toBe(URL);
  expect(rendezvousUrl("ws://localhost:8787")).toBe("ws://localhost:8787/v1/connect");
  for (const bad of ["https://x.example", "wss://x.example/path", "nope"]) {
    expect(rendezvousUrl(bad)).toBeNull();
  }
  expect(familiesFor(URL)).toEqual([4, 6]);
  expect(familiesFor("ws://localhost:8787/v1/connect")).toEqual([4, 6]);
  expect(familiesFor("ws://127.0.0.1:8787/v1/connect")).toEqual([4]);
  expect(familiesFor("ws://[::1]:8787/v1/connect")).toEqual([6]);
});

test("the host registers over IPv4 and IPv6 with one key and prints one line", async () => {
  const { nearby, log, last, sockets } = host();
  expect(nearby.key).toMatch(HOST_KEY);
  expect(sockets.map((s) => s.family)).toEqual([4, 6]);
  welcome(last(4)!, "a");
  expect(log).toEqual([]);
  welcome(last(6)!, "b");
  const hello: ClientMessage = { type: "hello", role: "host", name: "Desk", key: nearby.key };
  expect(last(4)!.sent).toEqual([hello]);
  expect(last(6)!.sent).toEqual([hello]);
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
  let closed = false;
  channel.stateChanged.subscribe((state) => {
    if (state === "closed") closed = true;
  });
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      const data: SignalData = { kind: "candidate", candidate: candidate.toJSON() };
      v6.receive({ type: "signal", from: "g1", data });
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription!.sdp;
  v6.receive({ type: "signal", from: "g1", data: { kind: "offer", sdp: offerSdp } });

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
  const proof = await authProof(code, sdpFingerprint(offerSdp)!, sdpFingerprint(answerSdp)!);
  channel.send(JSON.stringify({ t: "auth", proof } satisfies ChannelMessage));
  await until(() => received.length === 2);
  expect(received[0]).toEqual({ t: "auth-ok" });

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
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      v4.receive({
        type: "signal",
        from: "g1",
        data: { kind: "candidate", candidate: candidate.toJSON() },
      });
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  const offerSdp = pc.localDescription!.sdp;
  // As the rendezvous relays it: JSON text, parsed by the host's own reader.
  v4.receive({ type: "signal", from: "g1", data: { kind: "offer", sdp: offerSdp, resume: true } });
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

  const proof = await authProof(
    "unknown-token",
    sdpFingerprint(offerSdp)!,
    sdpFingerprint(answerSdp)!,
  );
  channel.send(JSON.stringify({ t: "resume", proof } satisfies ChannelMessage));
  await until(() => received.length === 1);
  expect(received).toEqual([{ t: "auth-fail", attemptsLeft: 3 }]);
  await until(() => log.some((line) => /code \d{6}$/.test(line)));
});

test("the werift guard is on while nearby runs", async () => {
  const before = process.listenerCount("unhandledRejection");
  const { nearby } = host();
  expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  nearby.stop();
  expect(process.listenerCount("unhandledRejection")).toBe(before);
});
