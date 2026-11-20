import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { guardWerift, isWeriftPeerError, stackFunctions } from "./guard.ts";

/** An error with `stack` as its stack, as if thrown there. */
function thrown(message: string, frames: string[], type: ErrorConstructor = Error) {
  const error = new type(message);
  error.stack = [`${error.name}${message ? `: ${message}` : ""}`, ...frames].join("\n");
  return error;
}

// Stacks werift 0.26.0 produced, under Node 22.1 from dist/gitui.js and under Bun from source.
const nodeAck = thrown("channel not found", [
  "    at Object.datachannelReceive [as execute] (file:///x/dist/gitui.js:16446:21)",
  "    at Event2.execute (file:///x/dist/gitui.js:3201:12)",
  "    at _SCTP.receive (file:///x/dist/gitui.js:13531:20)",
  "    at _SCTP.receiveDataChunk (file:///x/dist/gitui.js:13397:12)",
  "    at _SCTP.receiveChunk (file:///x/dist/gitui.js:13146:16)",
  "    at _SCTP.handleData (file:///x/dist/gitui.js:13079:18)",
  "    at transport.onData [as dataReceiver] (file:///x/dist/gitui.js:12964:12)",
]);
const bunPpid = thrown("", [
  "      at <anonymous> (/x/node_modules/werift/lib/index.mjs:19326:25)",
  "      at datachannelReceive (/x/node_modules/werift/lib/index.mjs:19326:31)",
  "      at execute (/x/node_modules/werift/lib/index.mjs:728:12)",
  "      at receive (/x/node_modules/werift/lib/index.mjs:15962:20)",
  "      at receiveDataChunk (/x/node_modules/werift/lib/index.mjs:15823:12)",
  "      at receiveChunk (/x/node_modules/werift/lib/index.mjs:15555:16)",
  "      at handleData (/x/node_modules/werift/lib/index.mjs:15493:18)",
]);
const nodeShortChunk = thrown(
  "Attempt to access memory outside buffer bounds",
  [
    "    at boundsError (node:internal/buffer:86:11)",
    "    at Buffer.readUInt32BE (node:internal/buffer:311:5)",
    "    at new _DataChunk (file:///x/dist/gitui.js:12500:23)",
    "    at parsePacket2 (file:///x/dist/gitui.js:12786:19)",
    "    at async _SCTP.handleData (file:///x/dist/gitui.js:13064:43)",
  ],
  RangeError,
);

test("stack frames are read in Node's format and Bun's", () => {
  expect(stackFunctions(nodeAck.stack!)).toEqual([
    "datachannelReceive",
    "execute",
    "receive",
    "receiveDataChunk",
    "receiveChunk",
    "handleData",
    "onData",
  ]);
  expect(stackFunctions(bunPpid.stack!).slice(0, 2)).toEqual([null, "datachannelReceive"]);
  expect(stackFunctions("Error\n    at file:///x/a.js:1:2\n    at async f (a.js:1:1)")).toEqual([
    null,
    "f",
  ]);
});

test("errors from werift's SCTP receive path are recognised; nothing else is", () => {
  for (const error of [nodeAck, bunPpid, nodeShortChunk]) {
    expect(isWeriftPeerError(error)).toBe(true);
  }
  const ours = thrown("channel not found", [
    "    at Bridge.receive (file:///x/dist/gitui.js:20000:1)",
    "    at GuestSession.receive (file:///x/dist/gitui.js:20100:1)",
  ]);
  for (const reason of [
    ours,
    new Error("channel not found"),
    thrown("x", ["    at handleDataSomewhere (a.js:1:1)"]),
    "channel not found",
    { message: "channel not found", stack: nodeAck.stack },
    null,
  ]) {
    expect(isWeriftPeerError(reason)).toBe(false);
  }
});

test("the guard takes werift's errors and rethrows any other", () => {
  const caught: Error[] = [];
  const unguard = guardWerift((error) => caught.push(error));
  try {
    const emit = (reason: unknown) => process.emit("unhandledRejection", reason, Promise.resolve());
    emit(nodeAck);
    emit(nodeShortChunk);
    expect(caught).toEqual([nodeAck, nodeShortChunk]);
    const other = new Error("a bug of ours");
    expect(() => emit(other)).toThrow(other);
  } finally {
    unguard();
  }
  expect(process.listenerCount("unhandledRejection")).toBe(0);
});

// ── In a process of its own (bun test takes unhandled rejections before process listeners) ──

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Runs `body` with the guard on in a fresh process; its exit code and output. */
function runGuarded(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "gitui-guard-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "script.ts");
  const at = (file: string) => JSON.stringify(path.join(import.meta.dirname, file));
  writeFileSync(
    script,
    [
      `import { guardWerift, isolate } from ${at("guard.ts")};`,
      `import { Tokens } from ${at("auth.ts")};`,
      `import { GuestSession } from ${at("peer.ts")};`,
      `import { crc32c, RTCPeerConnection } from ${JSON.stringify(import.meta.resolve("werift"))};`,
      `guardWerift((e) => console.log("caught", e.name, JSON.stringify(e.message)));`,
      body,
    ].join("\n"),
  );
  const run = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

test("a hostile guest's packets that werift chokes on are caught, and the host goes on", () => {
  const run = runGuarded(`
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel("gitui");
    await pc.setLocalDescription(await pc.createOffer());
    const session = new GuestSession({
      offerSdp: pc.localDescription.sdp,
      stunUrls: [],
      tokens: new Tokens(),
      resuming: true, // no code line
      signal: (data) => {
        if (data.kind === "answer") void pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        else if (data.kind === "candidate") void pc.addIceCandidate(data.candidate);
      },
      fetch: () => new Response(""),
      log: (line) => console.log(line),
      onEnd: () => console.log("session ended"),
    });
    pc.onicecandidate = ({ candidate }) => candidate && session.addCandidate(candidate.toJSON());
    await new Promise((resolve) => channel.stateChanged.subscribe((s) => s === "open" && resolve()));
    // An SCTP packet with a valid checksum around \`chunks\`.
    const packet = (chunks) => {
      const header = Buffer.alloc(12);
      header.writeUInt16BE(5000, 0);
      header.writeUInt16BE(5000, 2);
      header.writeUInt32LE(crc32c(Buffer.concat([header, Buffer.from(chunks)])), 8);
      return Buffer.concat([header, Buffer.from(chunks)]);
    };
    const { sctp, dtlsTransport } = pc.sctpTransport;
    const pause = () => new Promise((r) => setTimeout(r, 100));
    await sctp.send(999, 50, Buffer.from([2])); // DATA_CHANNEL_ACK for an unknown stream
    await pause();
    await sctp.send(channel.id, 77, Buffer.from("x")); // unknown payload protocol id
    await pause();
    await dtlsTransport.sendData(Buffer.alloc(40, 7)); // bad checksum
    await pause();
    await dtlsTransport.sendData(packet([0xee, 0, 0, 4])); // unknown chunk type
    await pause();
    await dtlsTransport.sendData(packet([0, 3, 0, 6, 1, 2, 0, 0])); // truncated DATA chunk
    await pause();
    console.log("still running");
    session.close();
    await pc.close();
    process.exit(0);
  `);
  expect(run.out.split("\n")).toEqual([
    'caught Error "channel not found"',
    'caught Error ""',
    'caught Error "SCTP packet has invalid checksum"',
    'caught Error "unknown"',
    expect.stringMatching(/^caught RangeError "/),
    "still running",
    "session ended",
    "",
  ]);
  expect(run.code).toBe(0);
});

// ── What isn't werift's still crashes the process ──────────────────────────────────────────

test("in a real process: werift's errors are survived, other rejections and our errors crash", () => {
  const later = `setTimeout(() => console.log("still running"), 100);\n`;
  const werift = runGuarded(
    `${later}const e = new Error("channel not found");\n` +
      `e.stack = ${JSON.stringify(nodeAck.stack)};\nPromise.reject(e);`,
  );
  expect(werift).toMatchObject({
    code: 0,
    out: 'caught Error "channel not found"\nstill running\n',
  });

  const other = runGuarded(`${later}Promise.reject(new Error("a bug of ours"));`);
  expect(other.code).toBe(1);
  expect(other.err).toContain("a bug of ours");
  expect(other.out).not.toContain("still running");

  // A callback of ours that throws while werift calls it crashes too, not as werift's error.
  const ours = runGuarded(
    `${later}async function handleData() { isolate(() => { throw new Error("our handler"); })(); }\n` +
      `void handleData();`,
  );
  expect(ours.code).toBe(1);
  expect(ours.err).toContain("our handler");
  expect(ours.out).not.toContain("caught");
});
