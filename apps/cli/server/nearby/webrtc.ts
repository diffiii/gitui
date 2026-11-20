// The WebRTC library behind nearby. Only this file imports it, so replacing werift (with
// node-datachannel, say) means rewriting this file against the same interface.
//
// werift is pure TypeScript: it bundles into dist/gitui.js and runs on Node and Bun with no
// native binaries. It resolves the mDNS (`.local`) host candidates browsers send, so a phone on
// the same network connects directly.
//
// Every callback werift gets goes through `isolate` (guard.ts): werift's SCTP code calls most of
// them while it handles a packet, and an error of ours must not pass for one of werift's there.
// Such an error goes to PeerEvents.error instead, which closes the session.
import { type RTCDataChannel, RTCPeerConnection } from "werift";
import { isolate } from "./guard.ts";

/** An ICE candidate as browsers' RTCIceCandidateInit carries it. */
export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** A data channel the guest opened. */
export interface DataChannel {
  readonly label: string;
  /** Bytes queued by `send` that haven't left yet. */
  readonly bufferedAmount: number;
  /** Throws once the channel has closed. */
  send(data: string | Uint8Array): void;
  /** Resolves once `bufferedAmount` is at most `threshold`, or the channel has closed. */
  drain(threshold: number): Promise<void>;
  /** Delivers the channel's messages and its closing; call it in `onChannel`, before any await. */
  listen(handlers: { message: (data: string | Uint8Array) => void; close: () => void }): void;
  close(): void;
}

export interface PeerEvents {
  /** A local candidate to trickle to the guest. */
  candidate: (candidate: IceCandidate) => void;
  /** The guest opened a data channel. */
  channel: (channel: DataChannel) => void;
  /** The connection failed or closed; the peer is of no further use. */
  closed: () => void;
  /** One of these callbacks threw; the session should end. */
  error: (error: unknown) => void;
}

/** A peer connection that answers a guest's offer. */
export interface AnsweringPeer {
  /**
   * Applies the guest's offer and returns the answer's SDP. Candidates are gathered after it
   * resolves, and trickled through `PeerEvents.candidate`.
   */
  answer(offerSdp: string): Promise<string>;
  /** Adds a candidate the guest trickled. Resolves even when the candidate was refused. */
  addCandidate(candidate: IceCandidate): Promise<void>;
  close(): void;
}

export function createAnsweringPeer(stunUrls: string[], events: PeerEvents): AnsweringPeer {
  const pc = new RTCPeerConnection({ iceServers: stunUrls.map((urls) => ({ urls })) });
  const guard: Guard = (fn) => isolate(fn, events.error);
  pc.onicecandidate = guard(({ candidate }) => {
    if (candidate) {
      const { sdpMid, sdpMLineIndex } = candidate;
      events.candidate({ candidate: candidate.candidate, sdpMid, sdpMLineIndex });
    }
  });
  pc.onDataChannel.subscribe(guard((channel) => events.channel(wrapChannel(channel, guard))));
  pc.connectionStateChange.subscribe(
    guard((state) => {
      if (state === "failed" || state === "closed") events.closed();
    }),
  );

  return {
    async answer(offerSdp) {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      // setLocalDescription waits for gathering, which trickles each candidate as it is found
      // (up to the STUN timeout); the answer needn't wait for that.
      pc.setLocalDescription(answer).catch(guard(() => events.closed()));
      return answer.sdp;
    },
    async addCandidate(candidate) {
      await pc.addIceCandidate(candidate).catch(() => {});
    },
    close() {
      pc.close().catch(() => {});
    },
  };
}

/** `fn`, isolated (guard.ts) with the peer's `error` event. */
type Guard = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;

function wrapChannel(dc: RTCDataChannel, guard: Guard): DataChannel {
  let closed = false;
  const onClose = new Set<() => void>();
  dc.stateChanged.subscribe(
    guard((state) => {
      if (state !== "closed") return;
      closed = true;
      for (const callback of onClose) callback();
    }),
  );

  return {
    label: dc.label,
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    send(data) {
      if (closed) throw new Error("data channel closed");
      dc.send(
        typeof data === "string"
          ? data
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      );
    },
    drain(threshold) {
      if (closed || dc.bufferedAmount <= threshold) return Promise.resolve();
      dc.bufferedAmountLowThreshold = threshold;
      return new Promise((resolve) => {
        const done = () => {
          low.unSubscribe();
          onClose.delete(done);
          resolve();
        };
        const low = dc.bufferedAmountLow.subscribe(guard(done));
        onClose.add(done);
      });
    },
    listen({ message, close }) {
      dc.onMessage.subscribe(guard(message));
      if (closed) close();
      else onClose.add(close);
    },
    close() {
      dc.close();
    },
  };
}
