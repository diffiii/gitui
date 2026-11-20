// One object per network (route.ts). It tells guests which hosts are online and relays signals
// between guests and hosts; network.ts makes those decisions, and this adapts it to the
// hibernation API. Its only state is the live sockets and their attachments, which survive
// hibernation, so an idle network costs no duration.
//
// Keepalive costs nothing either: the runtime answers WebSocket protocol pings (from hosts)
// itself, without waking the object or calling webSocketMessage, and the auto-response below
// answers RENDEZVOUS_PING (from browsers, which can't send protocol pings).
import { DurableObject } from "cloudflare:workers";
import { RENDEZVOUS_PING, RENDEZVOUS_PONG } from "@gitui/shared";
import type { Env } from "./index.ts";
import { Network, type Attachment, type Socket } from "./network.ts";

export class Rendezvous extends DurableObject<Env> {
  readonly #network = new Network(() => this.ctx.getWebSockets().map(socket));

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RENDEZVOUS_PING, RENDEZVOUS_PONG),
    );
  }

  override fetch(request: Request): Response {
    const admitted = this.#network.connect(request.headers.has("Origin"));
    if ("status" in admitted) return new Response(admitted.message, { status: admitted.status });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(admitted.attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    this.#network.message(socket(ws), raw);
  }

  // Both may run for one socket; what leave() sends is idempotent.
  override webSocketClose(ws: WebSocket): void {
    this.#network.leave(socket(ws));
  }

  override webSocketError(ws: WebSocket): void {
    this.#network.leave(socket(ws));
  }
}

function socket(ws: WebSocket): Socket {
  return {
    get attachment() {
      return ws.deserializeAttachment() as Attachment;
    },
    set attachment(value) {
      ws.serializeAttachment(value);
    },
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(message) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // The socket is closing; its own close handler tells the others.
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        // Already closing.
      }
    },
  };
}
