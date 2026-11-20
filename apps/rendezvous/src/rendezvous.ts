// One object per network (route.ts). It tells guests which hosts are online and relays signals
// between guests and hosts. Its only state is the live sockets and their attachments, which
// survive hibernation, so an idle network costs no duration.
//
// Keepalive costs nothing either: the runtime answers WebSocket protocol pings (from hosts)
// itself, without waking the object or calling webSocketMessage, and the auto-response below
// answers RENDEZVOUS_PING (from browsers, which can't send protocol pings).
import { DurableObject } from "cloudflare:workers";
import {
  MAX_MESSAGE_LENGTH,
  parseClientMessage,
  RENDEZVOUS_PING,
  RENDEZVOUS_PONG,
  type HostInfo,
  type ServerMessage,
} from "@gitui/shared";
import type { Env } from "./index.ts";

/** Most sockets one network may hold open. */
export const MAX_SOCKETS = 50;

/**
 * A peer that said hello. `seq` orders hosts by when they joined: one more than the highest of
 * the hosts online then. (Date.now() doesn't advance between messages without I/O, so it can't.)
 */
type Joined =
  | { role: "guest"; id: string }
  | { role: "host"; id: string; name: string; key: string; seq: number };

type Host = Extract<Joined, { role: "host" }>;

/**
 * A socket's attachment. Before `hello`, `browser` says whether the upgrade had an Origin, which
 * the Worker only lets through when it's allowed.
 */
type Attachment = { role?: undefined; browser: boolean } | Joined;

export class Rendezvous extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RENDEZVOUS_PING, RENDEZVOUS_PONG),
    );
  }

  override fetch(request: Request): Response {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("Too many peers on this network", { status: 503 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ browser: request.headers.has("Origin") } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") return reject(ws, 1003, "Expected a text message");
    if (raw.length > MAX_MESSAGE_LENGTH) return reject(ws, 1009, "Message too large");
    const message = parseClientMessage(raw);
    if (!message) return reject(ws, 1008, "Invalid message");
    const peer = attachment(ws);

    if (message.type === "hello") {
      if (peer.role) return reject(ws, 1008, "Already said hello");
      // Only the web app may list hosts; the CLI connects without an Origin.
      if (message.role === "guest" && !peer.browser) return reject(ws, 1008, "Origin required");
      const id = crypto.randomUUID();
      const joined: Joined =
        message.role === "host"
          ? { role: "host", id, name: message.name, key: message.key, seq: this.nextSeq() }
          : { role: "guest", id };
      ws.serializeAttachment(joined);
      send(ws, { type: "welcome", id });
      if (joined.role === "host") this.broadcastHosts();
      else send(ws, { type: "hosts", hosts: this.hosts() });
      return;
    }

    if (!peer.role) return reject(ws, 1008, "Say hello first");
    // Signals only go between a guest and a host. A same-role id gets the same answer as an
    // unknown one, so guests can't probe for each other.
    const target = this.peers().find(
      (other) => other.id === message.to && other.role !== peer.role,
    );
    if (!target) return send(ws, { type: "error", message: "Unknown peer" });
    send(target.ws, { type: "signal", from: peer.id, data: message.data });
  }

  // Both may run for one socket; the messages they send are idempotent.
  override webSocketClose(ws: WebSocket): void {
    this.leave(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.leave(ws);
  }

  /** Tells the other role's peers that `ws` is gone, and guests the new hosts if it was one. */
  private leave(ws: WebSocket): void {
    const peer = attachment(ws);
    if (!peer.role) return;
    for (const other of this.peers()) {
      if (other.role !== peer.role) send(other.ws, { type: "gone", id: peer.id });
    }
    if (peer.role === "host") this.broadcastHosts(peer.id);
  }

  private broadcastHosts(leaving?: string): void {
    const hosts = this.hosts(leaving);
    for (const peer of this.peers()) {
      if (peer.role === "guest") send(peer.ws, { type: "hosts", hosts });
    }
  }

  /**
   * One entry per key, sorted by name so guests list them in a stable order. A CLI's IPv4 and
   * IPv6 sockets share a key and land here together when both families map to this network;
   * the one that joined first is listed (so a later socket can't displace it), and the other
   * takes its place if it leaves. Both still accept signals.
   */
  private hosts(leaving?: string): HostInfo[] {
    const byKey = new Map<string, Host>();
    for (const peer of this.peers()) {
      if (peer.role !== "host" || peer.id === leaving) continue;
      const listed = byKey.get(peer.key);
      if (!listed || peer.seq < listed.seq) byKey.set(peer.key, peer);
    }
    return [...byKey.values()]
      .map(({ id, name, key }) => ({ id, name, key }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  private nextSeq(): number {
    return Math.max(0, ...this.peers().map((peer) => (peer.role === "host" ? peer.seq : 0))) + 1;
  }

  /** Open sockets that said hello. */
  private peers(): (Joined & { ws: WebSocket })[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const peer = attachment(ws);
      return peer.role && ws.readyState === WebSocket.OPEN ? [{ ...peer, ws }] : [];
    });
  }
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket is closing; its own close handler tells the others.
  }
}

function reject(ws: WebSocket, code: number, message: string): void {
  send(ws, { type: "error", message });
  ws.close(code, message);
}
