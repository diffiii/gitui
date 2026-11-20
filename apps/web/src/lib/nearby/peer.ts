import {
  CHANNEL_LOW_WATER,
  DATA_CHANNEL_LABEL,
  guestFinish,
  guestStart,
  newOfferId,
  resumeStart,
  resumeVerify,
  sdpFingerprint,
  STUN_URLS,
  type Fingerprints,
  type GuestMessage,
  type HostInfo,
  type HostMessage,
  type SignalData,
} from "@gitui/shared";
import { createChannelClient, decodeIncoming, type ChannelTransport } from "./channelFetch.ts";
import type { Rendezvous } from "./rendezvous.ts";

// The guest's WebRTC connection to a host: it makes the offer, trickles ICE candidates through
// the rendezvous, opens the data channel, runs CPace with the host's code (or proves a resume
// token from an earlier connection, and checks the host's proof of it), and then carries HTTP
// requests (channelFetch.ts).

/** A failure worth showing as is. */
export class NearbyError extends Error {
  override name = "NearbyError";
}

/**
 * The host answered a resume without proving it holds the token: whatever answers under this
 * host's key isn't the computer the guest paired with. Not worth retrying, and the code mustn't
 * be asked for on this connection.
 */
export class HostUnverifiedError extends NearbyError {
  override name = "HostUnverifiedError";
}

export type AuthResult = { ok: true } | { ok: false; attemptsLeft: number };

export interface GuestPeer {
  readonly host: HostInfo;
  /**
   * Run CPace with `code`. A host whose answer doesn't check out (a wrong code, or not the real
   * host) is told so and answers `auth-fail`. After `attemptsLeft: 0` the host closes the
   * connection.
   */
  authenticate(code: string): Promise<AuthResult>;
  /**
   * Prove a resume token instead of a code. Rejects with a HostUnverifiedError if the host
   * accepts without proving it holds the token too.
   */
  resume(token: string): Promise<AuthResult>;
  /** Hear the resume tokens the host sends after `auth-ok`. */
  onSession(listener: (token: string) => void): void;
  /** False once the channel closed or the connection failed, even if no event said so yet. */
  isOpen(): boolean;
  /** `fetch` for paths on the host, once authenticated. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Called once when the connection ends, with why; not after close(). */
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

/** How long the data channel may take to open. */
export const CONNECT_TIMEOUT = 20_000;
/** How long the host may take to answer the offer; a lost offer is better sent again. */
export const ANSWER_TIMEOUT = 5000;

function dataChannelTransport(channel: RTCDataChannel): ChannelTransport {
  channel.bufferedAmountLowThreshold = CHANNEL_LOW_WATER;
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
 * leaves, doesn't answer within `answerTimeout`, or the channel isn't open within `timeout`;
 * `signal` gives up early. `resume` tells the host the channel will open with `resume`, so it
 * prints no code unless that fails.
 */
export async function connectToHost(
  rendezvous: Rendezvous,
  host: HostInfo,
  {
    signal,
    timeout = CONNECT_TIMEOUT,
    answerTimeout = ANSWER_TIMEOUT,
    resume = false,
  }: { signal?: AbortSignal; timeout?: number; answerTimeout?: number; resume?: boolean } = {},
): Promise<GuestPeer> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] });
  // Ordered and reliable: no maxRetransmits or maxPacketLifeTime.
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
  channel.binaryType = "arraybuffer";

  // Signals of an earlier offer to this host (one that timed out, say) carry another id.
  const offerId = newOfferId();
  let answered = false;
  let remoteFingerprint: string | null = null;
  // Candidates that arrive before the answer wait for it: addIceCandidate needs a remote
  // description. Ours wait for the offer to go out, so the host never sees one before it.
  const early: RTCIceCandidateInit[] = [];
  let unsent: SignalData[] | null = [];
  let failSetup: (error: Error) => void = () => {};

  const onSignal = async (data: SignalData) => {
    if (data.offerId !== offerId) return;
    try {
      if (data.kind === "refused") {
        failSetup(
          new NearbyError(
            data.reason === "busy"
              ? `${host.name} is busy with other devices connecting. Try again in a moment.`
              : `${host.name} got too many connection requests. Try again in a minute.`,
          ),
        );
      } else if (data.kind === "answer" && !answered) {
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
      offerId,
      candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex },
    };
    if (unsent) unsent.push(data);
    else rendezvous.signal(host.id, data);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
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
      answerTimer = setTimeout(() => {
        if (!answered)
          reject(
            new NearbyError(`${host.name} didn't answer. Is gitui still running with --nearby?`),
          );
      }, answerTimeout);
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
        const data: SignalData = {
          kind: "offer",
          offerId,
          sdp: offer,
          ...(resume && { resume: true }),
        };
        if (!rendezvous.signal(host.id, data)) {
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
    clearTimeout(answerTimer);
    // Signaling is done once the channel is open: later candidates can't help an open channel.
    stopListening();
    pc.onicecandidate = pc.onconnectionstatechange = channel.onopen = null;
  }

  // Assigned in callbacks above, which TypeScript's narrowing can't see.
  const guest = localFingerprint as string | null;
  const remote = remoteFingerprint as string | null;
  if (!guest || !remote) {
    pc.close();
    throw new NearbyError("The connection has no single DTLS fingerprint to authenticate with.");
  }
  return openPeer(host, pc, channel, { guest, host: remote });
}

/** What the guest waits for during authentication: the host's next message. */
interface Waiting {
  receive(message: HostMessage): void;
  reject(error: Error): void;
}

function openPeer(
  host: HostInfo,
  pc: RTCPeerConnection,
  channel: RTCDataChannel,
  prints: Fingerprints,
): GuestPeer {
  const client = createChannelClient(dataChannelTransport(channel), (reason) =>
    console.warn(`nearby: dropped a message from ${host.name}: ${reason}`),
  );
  let authenticated = false;
  let waiting: Waiting | null = null;
  let closed = false;
  const closeListeners: ((reason: string) => void)[] = [];
  const sessionListeners: ((token: string) => void)[] = [];

  const end = (reason: string, notify: boolean) => {
    if (closed) return;
    closed = true;
    client.close(reason);
    waiting?.reject(new NearbyError(reason));
    waiting = null;
    channel.onmessage = channel.onclose = pc.onconnectionstatechange = null;
    pc.close();
    if (notify) closeListeners.forEach((l) => l(reason));
  };

  channel.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
    const incoming = decodeIncoming(data);
    const message = incoming.kind === "message" ? incoming.message : null;
    if (authenticated && message?.t === "session") {
      return sessionListeners.forEach((l) => l(message.token));
    }
    if (authenticated) return client.handle(incoming);
    if (!waiting || !message) {
      return console.warn(`nearby: ${host.name} sent a message before authentication`);
    }
    const w = waiting;
    waiting = null;
    w.receive(message);
  };
  channel.onclose = () => end(`${host.name} closed the connection.`, true);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      end(`The connection to ${host.name} dropped.`, true);
    }
  };

  const send = (message: GuestMessage) => {
    if (!closed) channel.send(JSON.stringify(message));
  };

  /** The host's next message during authentication. */
  const next = () => {
    if (closed) return Promise.reject(new NearbyError("The connection is closed."));
    if (waiting) return Promise.reject(new Error("already waiting for the host"));
    return new Promise<HostMessage>((resolve, reject) => {
      waiting = { receive: resolve, reject };
    });
  };

  /** A verdict that only `auth-fail` may give; anything else breaks the protocol. */
  const failure = (message: HostMessage): AuthResult => {
    if (message.t === "auth-fail") return { ok: false, attemptsLeft: message.attemptsLeft };
    end(`${host.name} broke the pairing protocol.`, true);
    throw new NearbyError(`${host.name} broke the pairing protocol.`);
  };

  const authenticate = async (code: string): Promise<AuthResult> => {
    if (authenticated) return { ok: true };
    const start = guestStart(code, prints);
    const answer = next();
    send(start.message);
    const reply = await answer;
    if (reply.t !== "pake") return failure(reply);
    // The host proves it knows the code, on this very connection, before the guest proves it.
    const confirm = guestFinish(start.state, reply);
    const verdict = next();
    send(confirm ?? { t: "pake-fail" });
    const result = await verdict;
    if (confirm && result.t === "auth-ok") {
      authenticated = true;
      return { ok: true };
    }
    // (`auth-ok` after a host tag that didn't check out proves nothing: `failure` refuses it.)
    return failure(result);
  };

  const resume = async (token: string): Promise<AuthResult> => {
    if (authenticated) return { ok: true };
    const message = resumeStart(token, prints);
    const answer = next();
    send(message);
    const reply = await answer;
    if (reply.t === "auth-fail") return failure(reply);
    if (reply.t === "resume-ok" && resumeVerify(token, prints, message, reply)) {
      authenticated = true;
      return { ok: true };
    }
    end(`Couldn't verify ${host.name}.`, false);
    throw new HostUnverifiedError(
      `Couldn't verify that this is ${host.name}: something on this network answered for it ` +
        "without proving it is the computer you paired with.",
    );
  };

  return {
    host,
    authenticate,
    resume,
    onSession: (listener) => void sessionListeners.push(listener),
    isOpen: () =>
      !closed &&
      channel.readyState === "open" &&
      pc.connectionState !== "failed" &&
      pc.connectionState !== "closed",
    fetch: (path, init) =>
      authenticated
        ? client.fetch(path, init)
        : Promise.reject(new NearbyError("Enter the code before sending requests.")),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => end("Disconnected.", false),
  };
}
