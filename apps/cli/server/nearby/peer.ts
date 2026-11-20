// One guest's connection, from its offer to its end: answers the offer, trickles candidates,
// takes the guest's data channel, checks its code (auth.ts) and then hands the channel to the
// bridge. Nothing reaches the bridge before the guest proved it knows the code.
import {
  AUTH_ATTEMPTS,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  type SignalData,
} from "@gitui/shared";
import { expectedProof, newCode, parseAuth, proofChecker, type Verdict } from "./auth.ts";
import { Bridge, type Fetch } from "./bridge.ts";
import { type AnsweringPeer, createAnsweringPeer, type DataChannel } from "./webrtc.ts";

/** How long a guest has, from its offer, to enter the code. */
export const AUTH_TIMEOUT = 60_000;

export interface GuestOptions {
  offerSdp: string;
  stunUrls: string[];
  /** Sends a signal to the guest through the rendezvous service. */
  signal: (data: SignalData) => void;
  /** Answers the guest's requests once it is authenticated. */
  fetch: Fetch;
  /** Prints a line for the person at this machine. */
  log: (line: string) => void;
  /** Called once, when the session ends for any reason. */
  onEnd: () => void;
  authTimeout?: number;
}

type State = "answering" | "authenticating" | "open" | "closed";

export class GuestSession {
  readonly #options: GuestOptions;
  readonly #peer: AnsweringPeer;
  readonly #answered: Promise<void>;
  readonly #timer: ReturnType<typeof setTimeout>;
  #state: State = "answering";
  #code = "";
  #check: ((proof: string) => Verdict) | null = null;
  #channel: DataChannel | null = null;
  #bridge: Bridge | null = null;

  constructor(options: GuestOptions) {
    this.#options = options;
    this.#peer = createAnsweringPeer(options.stunUrls, {
      candidate: (candidate) => options.signal({ kind: "candidate", candidate }),
      channel: (channel) => this.#take(channel),
      closed: () => this.close(),
    });
    this.#timer = setTimeout(
      () => this.close(this.#code ? `Nearby: code ${this.#code} expired` : undefined),
      options.authTimeout ?? AUTH_TIMEOUT,
    );
    this.#answered = this.#answer();
  }

  /** Whether the guest entered the right code. */
  get authenticated() {
    return this.#state === "open";
  }

  /** Adds a candidate the guest trickled, once the offer is applied. */
  addCandidate(candidate: Extract<SignalData, { kind: "candidate" }>["candidate"]) {
    void this.#answered.then(() => {
      if (this.#state !== "closed") return this.#peer.addCandidate(candidate);
    });
  }

  /** Ends the session, printing `line` if given. Safe to call more than once. */
  close(line?: string) {
    if (this.#state === "closed") return;
    const wasOpen = this.#state === "open";
    this.#state = "closed";
    clearTimeout(this.#timer);
    this.#bridge?.close();
    this.#channel?.close();
    this.#peer.close();
    if (line) this.#options.log(line);
    else if (wasOpen) this.#options.log("Nearby: device disconnected");
    this.#options.onEnd();
  }

  async #answer() {
    const { offerSdp, signal, log } = this.#options;
    try {
      const answerSdp = await this.#peer.answer(offerSdp);
      const code = newCode();
      const proof = await expectedProof(code, offerSdp, answerSdp);
      if (this.#state === "closed") return;
      if (!proof) return this.close("Nearby: refused an offer without a DTLS fingerprint");
      this.#code = code;
      this.#check = proofChecker(proof);
      this.#state = "authenticating";
      signal({ kind: "answer", sdp: answerSdp });
      log(`Nearby: a device wants to connect — code ${code}`);
    } catch (e) {
      this.close(`Nearby: couldn't answer a device: ${(e as Error).message}`);
    }
  }

  #take(channel: DataChannel) {
    // A gitui guest opens one channel, with the contract's label; anything else isn't one.
    if (this.#channel || channel.label !== DATA_CHANNEL_LABEL) return this.close();

    this.#channel = channel;
    channel.listen({
      message: (data) => this.#receive(channel, data),
      close: () => this.close(),
    });
  }

  #receive(channel: DataChannel, data: string | Uint8Array) {
    if (this.#bridge) return this.#bridge.receive(data);
    if (this.#state !== "authenticating" || !this.#check) return;
    const proof = parseAuth(data);
    if (proof === null) return this.close("Nearby: a device sent requests before its code");

    const verdict = this.#check(proof);
    const send = (message: ChannelMessage) => channel.send(JSON.stringify(message));
    if (verdict.ok) {
      clearTimeout(this.#timer);
      this.#state = "open";
      this.#bridge = new Bridge(channel, this.#options.fetch);
      send({ t: "auth-ok" });
      this.#options.log("Nearby: device connected");
      return;
    }
    send({ t: "auth-fail", attemptsLeft: verdict.attemptsLeft });
    if (verdict.attemptsLeft > 0) return;
    // Let the last auth-fail leave before the channel closes.
    this.#check = null;
    void channel
      .drain(0)
      .then(() =>
        this.close(`Nearby: refused a device that entered a wrong code ${AUTH_ATTEMPTS} times`),
      );
  }
}
