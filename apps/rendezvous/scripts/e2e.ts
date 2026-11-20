// End-to-end check of the rendezvous under `wrangler dev`: host keys, listing a key once, both
// keepalives and per-network routing. `wrangler dev` takes CF-Connecting-IP from the request, so
// the peers pick their addresses. Starts and stops its own servers on PORT and PORT + 1.
//
//   bun scripts/e2e.ts            # PORT defaults to 5187
import {
  RENDEZVOUS_PATH,
  RENDEZVOUS_PING,
  RENDEZVOUS_PONG,
  type HostInfo,
  type ServerMessage,
} from "@gitui/shared";

const PORT = Number(process.env.PORT ?? 5187);
const ORIGIN = "http://localhost:5181";
const TIMEOUT = 5000;

type Server = { url: string; stop: () => Promise<void> };

async function startServer(port: number, secret: string | null): Promise<Server> {
  const vars = [`ALLOWED_ORIGINS:${ORIGIN}`, ...(secret ? [`NETWORK_KEY_SECRET:${secret}`] : [])];
  const proc = Bun.spawn(
    [
      `${import.meta.dir}/../node_modules/.bin/wrangler`,
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
    ].concat(vars.flatMap((v) => ["--var", v])),
    { cwd: `${import.meta.dir}/..`, stdout: "ignore", stderr: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    proc.kill();
    await proc.exited;
  };
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(url).then(
        () => true,
        () => false,
      )
    )
      return { url, stop };
    await Bun.sleep(200);
  }
  await stop();
  throw new Error(`wrangler dev didn't start on ${port}`);
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
  async hello(role: "host", name: string, key: string): Promise<string>;
  async hello(role: "host" | "guest", name?: string, key?: string): Promise<string> {
    this.send(role === "host" ? { type: "hello", role, name, key } : { type: "hello", role });
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

const KEY = "e2e-key-0123456789";
const OTHER_KEY = "e2e-other-key-0123";
const NET_A = "198.51.100.1";
const NET_A_MAPPED = "::ffff:198.51.100.1"; // IPv4-mapped: the same network as NET_A
const NET_B = "2001:db8:1:2::5";

async function run(base: string): Promise<void> {
  await step("host hello needs a HOST_KEY-shaped key", async () => {
    for (const key of [undefined, "short", "x".repeat(65), "bad key with spaces!"]) {
      const host = await Peer.open(base, NET_A);
      host.send({ type: "hello", role: "host", name: "box", key });
      equal(await host.next("error"), { type: "error", message: "Invalid message" }, "error");
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
    await host.hello("host", "pinger", OTHER_KEY);
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
  await guest.hello("guest");
  equal((await guest.next("hosts")).hosts, [], "hosts at first");
  const v4 = await Peer.open(base, NET_A);
  const v6 = await Peer.open(base, NET_A_MAPPED);
  let v4Id = "";
  let v6Id = "";

  await step("a key's two sockets in one object are listed once, first come first", async () => {
    v4Id = await v4.hello("host", "box", KEY);
    equal((await guest.next("hosts")).hosts, [{ id: v4Id, name: "box", key: KEY }], "one host");
    v6Id = await v6.hello("host", "box", KEY);
    equal((await guest.next("hosts")).hosts, [{ id: v4Id, name: "box", key: KEY }], "still one");
  });

  await step("signals reach the socket that isn't listed", async () => {
    const offer = { kind: "offer", sdp: "v=0" } as const;
    guest.send({ type: "signal", to: v6Id, data: offer });
    const signal = await v6.next("signal");
    equal(signal.data, offer, "signal");
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
    const id = await host.hello("host", "box", KEY);
    equal((await other.next("hosts")).hosts, [{ id, name: "box", key: KEY }], "its own host");
    for (const peer of [other, host]) peer.ws.close();
  });

  for (const peer of [guest, v6]) peer.ws.close();
}

const server = await startServer(PORT, "e2e-secret");
try {
  await run(server.url);
} finally {
  await server.stop();
}

// Started with no secret (and no .dev.vars), it must refuse every connection.
const misconfigured = await startServer(PORT + 1, null);
try {
  await step("no NETWORK_KEY_SECRET: 500", async () => {
    const response = await fetch(`${misconfigured.url}${RENDEZVOUS_PATH}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": NET_A },
    });
    equal(response.status, 500, "status");
    check((await response.text()).includes("NETWORK_KEY_SECRET"), "message names the secret");
  });
} finally {
  await misconfigured.stop();
}
