// End-to-end check of the rendezvous under `wrangler dev`: host secrets and keys, listing a key
// once, both keepalives, per-network routing, refusals and limits. `wrangler dev` takes CF-Connecting-IP
// from the request, so the peers pick their addresses (each step its own network). Starts and
// stops its own servers on free ports between 5100 and 5199.
//
//   bun scripts/e2e.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostKey,
  MAX_MESSAGE_LENGTH,
  RENDEZVOUS_PATH,
  RENDEZVOUS_PING,
  RENDEZVOUS_PONG,
  type HostInfo,
  type ServerMessage,
} from "@gitui/shared";
import {
  GUEST_RATE_LIMIT,
  HELLO_TIMEOUT,
  MAX_HOSTS,
  MAX_SOCKETS,
  MAX_SOCKETS_PER_KEY,
} from "../src/network.ts";

const ORIGIN = "http://localhost:5181";
const TIMEOUT = 5000;

type Server = { url: string; stop: () => Promise<void> };
const running = new Set<Server>();
const taken = new Set<number>();

/** A port between 5100 and 5199 that nothing listens on now (and this script hasn't used). */
async function freePort(): Promise<number> {
  const first = 5100 + Math.floor(Math.random() * 100);
  for (let i = 0; i < 100; i++) {
    const port = 5100 + ((first - 5100 + i) % 100);
    if (taken.has(port)) continue;
    let probe;
    try {
      probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() });
    } catch {
      continue;
    }
    await probe.stop(true);
    taken.add(port);
    return port;
  }
  throw new Error("no free port between 5100 and 5199");
}

/**
 * Starts `wrangler dev` with its own state directory, retrying on other ports if it fails. Its
 * vars are only what's passed here: an empty --env-file stops wrangler from loading .dev.vars.
 */
async function startServer(secret: string | null): Promise<Server> {
  let output = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const state = mkdtempSync(join(tmpdir(), "rendezvous-e2e-"));
    const vars = [`ALLOWED_ORIGINS:${ORIGIN}`, ...(secret ? [`NETWORK_KEY_SECRET:${secret}`] : [])];
    const envFile = join(state, "empty.env");
    writeFileSync(envFile, "");
    const proc = Bun.spawn(
      [
        `${import.meta.dir}/../node_modules/.bin/wrangler`,
        "dev",
        ...["--port", String(port), "--ip", "127.0.0.1"],
        ...["--inspector-port", String(await freePort()), "--inspector-ip", "127.0.0.1"],
        ...["--persist-to", state, "--env-file", envFile, "--show-interactive-dev-session=false"],
      ].concat(vars.flatMap((v) => ["--var", v])),
      {
        cwd: `${import.meta.dir}/..`,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          // Don't let the shell's environment in as secrets either.
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    output = "";
    for (const stream of [proc.stdout, proc.stderr]) {
      void (async () => {
        for await (const chunk of stream.pipeThrough(new TextDecoderStream())) output += chunk;
      })();
    }
    const url = `http://127.0.0.1:${port}`;
    const server: Server = {
      url,
      stop: async () => {
        running.delete(server);
        proc.kill("SIGTERM");
        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000)]);
        if (!exited) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        rmSync(state, { recursive: true, force: true });
      },
    };
    running.add(server);
    for (let i = 0; i < 150 && proc.exitCode === null; i++) {
      const up = await fetch(url).then(
        () => true,
        () => false,
      );
      if (up) return server;
      await Bun.sleep(200);
    }
    await server.stop();
  }
  console.error(output);
  throw new Error("wrangler dev didn't start");
}

// Don't leave servers behind when interrupted.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.all([...running].map((server) => server.stop())).finally(() => process.exit(130));
  });
}

/** A rendezvous socket that queues what it receives. */
class Peer {
  readonly queue: string[] = [];
  private waiting: (() => void) | null = null;
  readonly closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      this.queue.push(String(event.data));
      this.waiting?.();
    });
    this.closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  }

  static open(base: string, ip: string, browser = false): Promise<Peer> {
    const headers: Record<string, string> = { "CF-Connecting-IP": ip };
    if (browser) headers.Origin = ORIGIN;
    const ws = new WebSocket(`${base.replace("http", "ws")}${RENDEZVOUS_PATH}`, { headers });
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Peer(ws)));
      ws.addEventListener("error", () => reject(new Error(`can't connect as ${ip}`)));
    });
  }

  send(value: unknown): void {
    this.ws.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  async raw(): Promise<string> {
    const deadline = Date.now() + TIMEOUT;
    while (this.queue.length === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a message");
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        setTimeout(resolve, 100);
      });
    }
    return this.queue.shift()!;
  }

  /** The next message, which must have this type. */
  async next<T extends ServerMessage["type"]>(
    type: T,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const message = JSON.parse(await this.raw()) as ServerMessage;
    check(message.type === type, `expected ${type}, got ${JSON.stringify(message)}`);
    return message as Extract<ServerMessage, { type: T }>;
  }

  async hello(role: "guest"): Promise<string>;
  async hello(role: "host", name: string, secret: string): Promise<string>;
  async hello(role: "host" | "guest", name?: string, secret?: string): Promise<string> {
    this.send(role === "host" ? { type: "hello", role, name, secret } : { type: "hello", role });
    return (await this.next("welcome")).id;
  }
}

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, what: string): void {
  const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
  check(a === b, `${what}: expected ${b}, got ${a}`);
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  console.log(`ok - ${name}`);
}

/** A HOST_SECRET-shaped secret per `label`, and the key it is listed under. */
const secret = (label: string) => `e2e-secret-${label}`.padEnd(43, "_");
const SECRET = secret("cli");
const KEY = hostKey(SECRET);
const OTHER_SECRET = secret("other");
const NET_A = "198.51.100.1";
const NET_A_MAPPED = "::ffff:198.51.100.1"; // IPv4-mapped: the same network as NET_A
const NET_B = "2001:db8:1:2::5";

async function run(base: string): Promise<void> {
  await step("host hello needs a HOST_SECRET-shaped secret", async () => {
    for (const bad of [undefined, "short", "x".repeat(129), `${"x".repeat(43)} !`]) {
      const host = await Peer.open(base, NET_A);
      host.send({ type: "hello", role: "host", name: "box", secret: bad });
      const error = { type: "error", code: "invalid-message", message: "Invalid message" };
      equal(await host.next("error"), error, "error");
      equal(await host.closed, 1008, "close code");
    }
  });

  await step("RENDEZVOUS_PING gets RENDEZVOUS_PONG, before and after hello", async () => {
    const guest = await Peer.open(base, NET_A, true);
    guest.send(RENDEZVOUS_PING);
    equal(await guest.raw(), RENDEZVOUS_PONG, "pong");
    await guest.hello("guest");
    await guest.next("hosts");
    guest.send(RENDEZVOUS_PING);
    equal(await guest.next("pong"), { type: "pong" }, "pong");
    guest.ws.close();
  });

  await step("protocol pings get protocol pongs", async () => {
    const host = await Peer.open(base, NET_A);
    await host.hello("host", "pinger", OTHER_SECRET);
    const pong = new Promise<void>((resolve) => host.ws.addEventListener("pong", () => resolve()));
    host.ws.ping();
    await Promise.race([pong, Bun.sleep(TIMEOUT).then(() => Promise.reject(new Error("no pong")))]);
    // The ping never reached webSocketMessage, which would have answered a non-text message
    // with an error and a close: the next thing the socket gets is the text keepalive's pong.
    host.send(RENDEZVOUS_PING);
    equal(await host.raw(), RENDEZVOUS_PONG, "next message");
    host.ws.close();
  });

  const guest = await Peer.open(base, NET_A, true);
  const guestId = await guest.hello("guest");
  equal((await guest.next("hosts")).hosts, [], "hosts at first");
  const v4 = await Peer.open(base, NET_A);
  const v6 = await Peer.open(base, NET_A_MAPPED);
  let v4Id = "";
  let v6Id = "";

  await step("a key's two sockets in one object are listed once, first come first", async () => {
    v4Id = await v4.hello("host", "box", SECRET);
    equal((await guest.next("hosts")).hosts, [{ id: v4Id, name: "box", key: KEY }], "one host");
    v6Id = await v6.hello("host", "box", SECRET);
    equal((await guest.next("hosts")).hosts, [{ id: v4Id, name: "box", key: KEY }], "still one");
  });

  await step("signals reach the socket that isn't listed", async () => {
    const offer = { kind: "offer", offerId: "offer-0123456789ab", sdp: "v=0" } as const;
    guest.send({ type: "signal", to: v6Id, data: offer });
    const signal = await v6.next("signal");
    equal(signal.data, offer, "signal");
    const refused = { kind: "refused", offerId: offer.offerId, reason: "busy" } as const;
    v6.send({ type: "signal", to: guestId, data: refused });
    equal((await guest.next("signal")).data, refused, "refusal");
  });

  await step("when the listed socket leaves, the other takes its place", async () => {
    v4.ws.close();
    equal(await guest.next("gone"), { type: "gone", id: v4Id }, "gone");
    const hosts: HostInfo[] = (await guest.next("hosts")).hosts;
    equal(hosts, [{ id: v6Id, name: "box", key: KEY }], "hosts");
  });

  await step("each network has its own object", async () => {
    const other = await Peer.open(base, NET_B, true);
    await other.hello("guest");
    equal((await other.next("hosts")).hosts, [], "hosts on another network");
    const host = await Peer.open(base, NET_B);
    const id = await host.hello("host", "box", SECRET);
    equal((await other.next("hosts")).hosts, [{ id, name: "box", key: KEY }], "its own host");
    for (const peer of [other, host]) peer.ws.close();
  });

  for (const peer of [guest, v6]) peer.ws.close();

  await step("a bad Origin gets a 403", async () => {
    equal((await upgrade(base, net(), "https://evil.example")).status, 403, "status");
  });

  await step("a guest leaving sends gone to every host", async () => {
    const ip = net();
    const hosts = [await Peer.open(base, ip), await Peer.open(base, ip)];
    for (const [i, host] of hosts.entries()) await host.hello("host", "box", secret(`${i}`));
    const leaving = await Peer.open(base, ip, true);
    const id = await leaving.hello("guest");
    leaving.ws.close();
    for (const host of hosts) equal(await host.next("gone"), { type: "gone", id }, "gone");
    for (const host of hosts) host.ws.close();
  });

  await step("refusals: no Origin, a second hello, a guest signaling a guest", async () => {
    const ip = net();
    const cli = await Peer.open(base, ip);
    cli.send({ type: "hello", role: "guest" });
    const noOrigin = { type: "error", code: "origin-required", message: "Origin required" };
    equal(await cli.next("error"), noOrigin, "no Origin");
    equal(await cli.closed, 1008, "close code");

    const [a, b] = [await Peer.open(base, ip, true), await Peer.open(base, ip, true)];
    await a.hello("guest");
    await a.next("hosts");
    const bId = await b.hello("guest");
    await b.next("hosts");
    a.send({
      type: "signal",
      to: bId,
      data: { kind: "offer", offerId: "offer-0123456789ab", sdp: "v=0" },
    });
    const unknown = { type: "error", code: "unknown-peer", message: "Unknown peer" };
    equal(await a.next("error"), unknown, "guest to guest");
    b.send({ type: "hello", role: "guest" });
    const again = { type: "error", code: "invalid-message", message: "Already said hello" };
    equal(await b.next("error"), again, "hello");
    equal(await b.closed, 1008, "close code");
    a.ws.close();
  });

  await step("binary messages close with 1003, oversized ones with 1009", async () => {
    const binary = await Peer.open(base, net(), true);
    binary.ws.send(new Uint8Array([1, 2, 3]));
    equal(await binary.closed, 1003, "binary");
    const large = await Peer.open(base, net(), true);
    large.send("x".repeat(MAX_MESSAGE_LENGTH + 1));
    equal(await large.closed, 1009, "oversized");
  });

  await step(`over ${GUEST_RATE_LIMIT} messages in a window closes with 1008`, async () => {
    const ip = net();
    const host = await Peer.open(base, ip);
    const hostId = await host.hello("host", "box", SECRET);
    const flood = await Peer.open(base, ip, true);
    await flood.hello("guest");
    for (let i = 0; i < GUEST_RATE_LIMIT; i++) {
      flood.send({
        type: "signal",
        to: hostId,
        data: { kind: "offer", offerId: "offer-0123456789ab", sdp: `${i}` },
      });
    }
    equal(await flood.closed, 1008, "close code");
    const relayed = flood.queue.filter((text) => text.includes('"code":"rate-limit"'));
    equal(relayed.length, 1, "error before the close");
    host.ws.close();
  });

  await step(`host ${MAX_HOSTS + 1} gets 1013, a known key and guests still get in`, async () => {
    const ip = net();
    const hosts: Peer[] = [];
    for (let i = 0; i < MAX_HOSTS; i++) {
      const host = await Peer.open(base, ip);
      await host.hello("host", "box", secret(`${i}`));
      hosts.push(host);
    }
    const extra = await Peer.open(base, ip);
    extra.send({ type: "hello", role: "host", name: "box", secret: OTHER_SECRET });
    equal((await extra.next("error")).code, "host-limit", "error code");
    equal(await extra.closed, 1013, "close code");
    // A host reconnecting with its key isn't another host.
    const again = await Peer.open(base, ip);
    await again.hello("host", "box", secret("0"));
    hosts.push(again);
    const guest = await Peer.open(base, ip, true);
    await guest.hello("guest");
    equal((await guest.next("hosts")).hosts.length, MAX_HOSTS, "hosts listed");
    for (const peer of [...hosts, guest]) peer.ws.close();
  });

  await step("only the secret's holder takes its key's sockets", async () => {
    const ip = net();
    const guest = await Peer.open(base, ip, true);
    await guest.hello("guest");
    await guest.next("hosts");
    // A co-tenant that read the key from the list and sends it as a secret gets its own key.
    const squatters: Peer[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_KEY; i++) {
      const squatter = await Peer.open(base, ip);
      await squatter.hello("host", "box", KEY.padEnd(43, "x"));
      squatters.push(squatter);
    }
    const owners: Peer[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_KEY; i++) {
      const owner = await Peer.open(base, ip);
      await owner.hello("host", "box", SECRET);
      owners.push(owner);
    }
    const extra = await Peer.open(base, ip);
    extra.send({ type: "hello", role: "host", name: "box", secret: SECRET });
    equal((await extra.next("error")).code, "key-limit", "error code");
    equal(await extra.closed, 1013, "close code");
    for (const peer of [guest, ...squatters, ...owners]) peer.ws.close();
  });

  await step(`past ${MAX_SOCKETS} sockets a 503, until silent ones time out`, async () => {
    const ip = net();
    const silent = await Promise.all(
      Array.from({ length: MAX_SOCKETS }, () => Peer.open(base, ip, true)),
    );
    equal((await upgrade(base, ip, ORIGIN)).status, 503, "status when full");
    await Bun.sleep(HELLO_TIMEOUT + 500);
    const late = await Peer.open(base, ip, true);
    for (const peer of silent) equal(await peer.closed, 1008, "silent socket closed");
    await late.hello("guest");
    late.ws.close();
  });
}

let nets = 0;
/** A network no other step uses. */
function net(): string {
  return `203.0.113.${++nets}`;
}

/** A WebSocket upgrade request with fetch, for its status. */
function upgrade(base: string, ip: string, origin?: string): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  return fetch(`${base}${RENDEZVOUS_PATH}`, { headers });
}

const server = await startServer("e2e-secret");
try {
  await run(server.url);
} finally {
  await server.stop();
}

// Started with no secret (.dev.vars isn't loaded), it must refuse every connection.
const misconfigured = await startServer(null);
try {
  await step("no NETWORK_KEY_SECRET: 500", async () => {
    const response = await upgrade(misconfigured.url, NET_A);
    equal(response.status, 500, "status");
    check((await response.text()).includes("NETWORK_KEY_SECRET"), "message names the secret");
  });
} finally {
  await misconfigured.stop();
}
