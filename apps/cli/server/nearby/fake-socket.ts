// For tests: a SocketFactory whose sockets the test drives, standing in for the service.
import { EventEmitter } from "node:events";
import type { ClientMessage } from "@gitui/shared";
import type { Family, RendezvousSocket, SocketFactory } from "./rendezvous.ts";

export class FakeSocket extends EventEmitter implements RendezvousSocket {
  readyState = 0;
  /** What the client sent, parsed. */
  sent: ClientMessage[] = [];
  pings = 0;
  terminated = false;

  constructor(
    readonly url: string,
    readonly family: Family,
  ) {
    super();
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
    this.#close();
  }
  close() {
    this.#close();
  }

  /** The service accepts the connection. */
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  /** The connection fails, or the service drops it. */
  fail() {
    this.emit("error", new Error("connect ECONNREFUSED"));
    this.#close();
  }
  /** The service sends `message` as a text frame. */
  receive(message: object | string) {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    this.emit("message", Buffer.from(text), false);
  }

  #close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

/** A factory that records every socket it opens. */
export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const open: SocketFactory = (url, family) => {
    const socket = new FakeSocket(url, family);
    sockets.push(socket);
    return socket;
  };
  return {
    open,
    sockets,
    /** The latest socket of `family`. */
    last: (family: Family) => sockets.findLast((s) => s.family === family),
  };
}
