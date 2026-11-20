// For tests: a peer connection (GuestOptions.peer) the test drives instead of werift's.
import type { IceCandidate } from "@gitui/shared";
import type { AnsweringPeer, PeerEvents } from "./webrtc.ts";

/** An SDP whose only fingerprint is SHA-256 `byte` repeated, as sdpFingerprint reads it. */
export const sdpWithPrint = (byte: string) =>
  `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(":")}\r\n`;

export interface FakePeer {
  /** The session's callbacks, to fire as werift would. */
  events: PeerEvents;
  /** The candidates the session added. */
  added: IceCandidate[];
  closed: boolean;
}

/** A factory of fake peers whose answers have a fingerprint; `closeThrows` makes `close` throw. */
export function fakePeers({ closeThrows = () => false }: { closeThrows?: () => boolean } = {}) {
  const peers: FakePeer[] = [];
  const peer = (_stunUrls: string[], events: PeerEvents): AnsweringPeer => {
    const fake: FakePeer = { events, added: [], closed: false };
    const throws = closeThrows();
    peers.push(fake);
    return {
      answer: async () => sdpWithPrint("ab"),
      async addCandidate(candidate) {
        fake.added.push(candidate);
      },
      close() {
        fake.closed = true;
        if (throws) throw new Error("teardown failed");
      },
    };
  };
  return { peer, peers };
}
