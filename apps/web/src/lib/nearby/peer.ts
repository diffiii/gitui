import {
  authProof,
  DATA_CHANNEL_LABEL,
  sdpFingerprint,
  STUN_URLS,
  type ChannelMessage,
  type HostInfo,
  type SignalData,
} from "@gitui/shared";
import {
  createChannelClient,
  decodeIncoming,
  SEND_HIGH_WATER,
  type ChannelTransport,
} from "./channelFetch.ts";
import type { Rendezvous } from "./rendezvous.ts";

// The guest's WebRTC connection to a host: it makes the offer, trickles ICE candidates through
// the rendezvous, opens the data channel, proves it knows the host's code, and then carries HTTP
// requests (channelFetch.ts).

/** A failure worth showing as is. */
export class NearbyError extends Error {
  override name = "NearbyError";
}

export type AuthResult = { ok: true } | { ok: false; attemptsLeft: number };

export interface GuestPeer {
  readonly host: HostInfo;
  /** Send the proof for `code`. After `attemptsLeft: 0` the host closes the connection. */
  authenticate(code: string): Promise<AuthResult>;
  /** `fetch` for paths on the host, once authenticated. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Called once when the connection ends, with why; not after close(). */
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

/** How long the data channel may take to open. */
export const CONNECT_TIMEOUT = 20_000;

function dataChannelTransport(channel: RTCDataChannel): ChannelTransport {
  channel.bufferedAmountLowThreshold = SEND_HIGH_WATER / 4;
  return {
    send: (data) => (typeof data === "string" ? channel.send(data) : channel.send(data)),
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    drained: () =>
      new Promise((resolve) => {
        if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return resolve();
        // A closed channel never drains; the sender then finds its request failed.
        channel.addEventListener("bufferedamountlow", () => resolve(), { once: true });
        channel.addEventListener("close", () => resolve(), { once: true });
      }),
  };
}

/**
 * Open a data channel to `host` through `rendezvous`. Rejects with a NearbyError if the host
 * leaves, or the channel isn't open within `timeout`; `signal` gives up early.
 */
export async function connectToHost(
  rendezvous: Rendezvous,
  host: HostInfo,
  { signal, timeout = CONNECT_TIMEOUT }: { signal?: AbortSignal; timeout?: number } = {},
): Promise<GuestPeer> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] });
  // Ordered and reliable: no maxRetransmits or maxPacketLifeTime.
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
  channel.binaryType = "arraybuffer";

  let answered = false;
  let remoteFingerprint: string | null = null;
  // Candidates that arrive before the answer wait for it: addIceCandidate needs a remote
  // description. Ours wait for the offer to go out, so the host never sees one before it.
  const early: RTCIceCandidateInit[] = [];
  let unsent: SignalData[] | null = [];
  let failSetup: (error: Error) => void = () => {};

  const onSignal = async (data: SignalData) => {
    try {
      if (data.kind === "answer" && !answered) {
        answered = true;
        remoteFingerprint = sdpFingerprint(data.sdp);
        await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        for (const candidate of early.splice(0)) await pc.addIceCandidate(candidate);
      } else if (data.kind === "candidate") {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else early.push(data.candidate);
      }
    } catch (e) {
      failSetup(new NearbyError(`${host.name} sent a signal this browser can't use: ${String(e)}`));
    }
  };
  const stopListening = rendezvous.listen(host.id, {
    signal: (data) => void onSignal(data),
    gone: () => failSetup(new NearbyError(`Lost touch with ${host.name} before it connected.`)),
  });
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return; // the protocol has no end-of-candidates signal
    const { sdpMid, sdpMLineIndex } = candidate;
    const data: SignalData = {
      kind: "candidate",
      candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex },
    };
    if (unsent) unsent.push(data);
    else rendezvous.signal(host.id, data);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let localFingerprint: string | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      failSetup = reject;
      timer = setTimeout(
        () =>
          reject(
            new NearbyError(
              answered
                ? `Couldn't open a direct connection to ${host.name}. Both devices must be on the same network, and some networks (guest Wi-Fi, VPNs) block it.`
                : `${host.name} didn't answer. Is gitui still running with --nearby?`,
            ),
          ),
        timeout,
      );
      signal?.throwIfAborted();
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          reject(new NearbyError(`The connection to ${host.name} failed.`));
        }
      };
      channel.onopen = () => resolve();
      void (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        const offer = pc.localDescription!.sdp;
        localFingerprint = sdpFingerprint(offer);
        if (!rendezvous.signal(host.id, { kind: "offer", sdp: offer })) {
          throw new NearbyError("Not connected to the rendezvous server. Try again.");
        }
        for (const data of unsent ?? []) rendezvous.signal(host.id, data);
        unsent = null;
      })().catch(reject);
    });
  } catch (e) {
    pc.close();
    throw e;
  } finally {
    clearTimeout(timer);
    // Signaling is done once the channel is open: later candidates can't help an open channel.
    stopListening();
    pc.onicecandidate = pc.onconnectionstatechange = channel.onopen = null;
  }

  // Assigned in callbacks above, which TypeScript's narrowing can't see.
  const guest = localFingerprint as string | null;
  const remote = remoteFingerprint as string | null;
  if (!guest || !remote) {
    pc.close();
    throw new NearbyError("The connection has no DTLS fingerprint to authenticate with.");
  }
  return openPeer(host, pc, channel, guest, remote);
}

function openPeer(
  host: HostInfo,
  pc: RTCPeerConnection,
  channel: RTCDataChannel,
  localFingerprint: string,
  remoteFingerprint: string,
): GuestPeer {
  const client = createChannelClient(dataChannelTransport(channel), (reason) =>
    console.warn(`nearby: dropped a message from ${host.name}: ${reason}`),
  );
  let authenticated = false;
  let awaitingAuth: { resolve(r: AuthResult): void; reject(e: Error): void } | null = null;
  let closed = false;
  const closeListeners: ((reason: string) => void)[] = [];

  const end = (reason: string, notify: boolean) => {
    if (closed) return;
    closed = true;
    client.close(reason);
    awaitingAuth?.reject(new NearbyError(reason));
    awaitingAuth = null;
    channel.onmessage = channel.onclose = pc.onconnectionstatechange = null;
    pc.close();
    if (notify) closeListeners.forEach((l) => l(reason));
  };

  channel.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
    if (authenticated) return client.receive(data);
    const incoming = decodeIncoming(data);
    const message = incoming.kind === "message" ? incoming.message : null;
    if (!awaitingAuth || (message?.t !== "auth-ok" && message?.t !== "auth-fail")) {
      return console.warn(`nearby: ${host.name} sent a message before authentication`);
    }
    const waiting = awaitingAuth;
    awaitingAuth = null;
    authenticated = message.t === "auth-ok";
    waiting.resolve(
      message.t === "auth-ok" ? { ok: true } : { ok: false, attemptsLeft: message.attemptsLeft },
    );
  };
  channel.onclose = () => end(`${host.name} closed the connection.`, true);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") end(`The connection to ${host.name} dropped.`, true);
  };

  return {
    host,
    authenticate: async (code) => {
      if (closed) throw new NearbyError("The connection is closed.");
      if (authenticated) return { ok: true };
      if (awaitingAuth) throw new Error("authenticate is already waiting for an answer");
      const answer = new Promise<AuthResult>((resolve, reject) => {
        awaitingAuth = { resolve, reject };
      });
      const proof = await authProof(code, localFingerprint, remoteFingerprint);
      if (!closed) channel.send(JSON.stringify({ t: "auth", proof } satisfies ChannelMessage));
      return answer;
    },
    fetch: (path, init) =>
      authenticated
        ? client.fetch(path, init)
        : Promise.reject(new NearbyError("Enter the code before sending requests.")),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => end("Disconnected.", false),
  };
}
