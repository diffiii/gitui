// The WebRTC library behind nearby. Only this file imports it, so replacing werift (with
// node-datachannel, say) means rewriting this file against the same interface.
//
// werift is pure TypeScript: it bundles into dist/gitui.js and runs on Node and Bun with no
// native binaries. It resolves the mDNS (`.local`) host candidates browsers send, so a phone on
// the same network connects directly.
import { type RTCDataChannel, RTCPeerConnection } from "werift";

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
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      const { sdpMid, sdpMLineIndex } = candidate;
      events.candidate({ candidate: candidate.candidate, sdpMid, sdpMLineIndex });
    }
  };
  pc.onDataChannel.subscribe((channel) => events.channel(wrapChannel(channel)));
  pc.connectionStateChange.subscribe((state) => {
    if (state === "failed" || state === "closed") events.closed();
  });

  return {
    async answer(offerSdp) {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      // setLocalDescription waits for gathering, which trickles each candidate as it is found
      // (up to the STUN timeout); the answer needn't wait for that.
      pc.setLocalDescription(answer).catch(() => events.closed());
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

function wrapChannel(dc: RTCDataChannel): DataChannel {
  let closed = false;
  const onClose = new Set<() => void>();
  dc.stateChanged.subscribe((state) => {
    if (state !== "closed") return;
    closed = true;
    for (const callback of onClose) callback();
  });

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
        const low = dc.bufferedAmountLow.subscribe(done);
        onClose.add(done);
      });
    },
    listen({ message, close }) {
      dc.onMessage.subscribe(message);
      if (closed) close();
      else onClose.add(close);
    },
    close() {
      dc.close();
    },
  };
}
