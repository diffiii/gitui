// One guest's connection, from its offer to its end: answers the offer, trickles candidates,
// takes the guest's data channel, checks its code or resume token (auth.ts) and then hands the
// channel to the bridge. Nothing reaches the bridge before the guest proved itself.
import {
  AUTH_ATTEMPTS,
  authProof,
  type ChannelMessage,
  DATA_CHANNEL_LABEL,
  type SignalData,
} from "@gitui/shared";
import { safeEqual } from "../access.ts";
import { Attempts, findProof, fingerprints, newCode, parseOpening, type Tokens } from "./auth.ts";
import { Bridge, type Fetch } from "./bridge.ts";
import { type AnsweringPeer, createAnsweringPeer, type DataChannel } from "./webrtc.ts";

/** How long a guest has, from its offer, to prove itself. */
export const AUTH_TIMEOUT = 60_000;

export interface GuestOptions {
  offerSdp: string;
  /**
   * The offer said the guest will `resume` (SignalData): the code is printed only if that
   * fails, so reconnections print nothing. Otherwise it is printed once the channel opens.
   */
  resuming?: boolean;
  stunUrls: string[];
  /** Sends a signal to the guest through the rendezvous service. */
  signal: (data: SignalData) => void;
  /** Answers the guest's requests once it is authenticated. */
  fetch: Fetch;
  /** This run's resume tokens: checked for `resume`, added to after a code. */
  tokens: Tokens;
  /** Prints a line for the person at this machine. */
  log: (line: string) => void;
  /** Called once, when the session ends for any reason. */
  onEnd: () => void;
  authTimeout?: number;
}

type State = "answering" | "authenticating" | "open" | "closed";

/** What the guest's opening is checked against, once the answer is made. */
interface Expected {
  code: string;
  codeProof: string;
  /** The live tokens when the offer came, and their proofs for this connection. */
  tokens: readonly string[];
  tokenProofs: string[];
}

export class GuestSession {
  readonly #options: GuestOptions;
  readonly #peer: AnsweringPeer;
  readonly #answered: Promise<void>;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #attempts = new Attempts();
  /** Whether the guest sent its opening (`auth` or `resume`) yet. */
  #opened = false;
  #state: State = "answering";
  #expected: Expected | null = null;
  #codeShown = false;
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
      () =>
        this.close(this.#codeShown ? `Nearby: code ${this.#expected?.code} expired` : undefined),
      options.authTimeout ?? AUTH_TIMEOUT,
    );
    this.#answered = this.#answer();
  }

  /** Whether the guest entered the right code or resumed. */
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
    const { offerSdp, signal, tokens } = this.#options;
    try {
      const answerSdp = await this.#peer.answer(offerSdp);
      const prints = fingerprints(offerSdp, answerSdp);
      // (A session closed meanwhile stays closed, and quiet.)
      if (!prints) return this.close("Nearby: refused an offer without a DTLS fingerprint");
      const code = newCode();
      const live = [...tokens.list()];
      const [codeProof, ...tokenProofs] = await Promise.all(
        [code, ...live].map((secret) => authProof(secret, prints.guest, prints.host)),
      );
      if (this.#state === "closed") return;
      this.#expected = { code, codeProof, tokens: live, tokenProofs };
      this.#state = "authenticating";
      signal({ kind: "answer", sdp: answerSdp });
    } catch (e) {
      this.close(`Nearby: couldn't answer a device: ${(e as Error).message}`);
    }
  }

  /** Prints the code, once, while the guest may still enter it. */
  #showCode() {
    if (this.#codeShown || this.#state !== "authenticating" || !this.#expected) return;
    this.#codeShown = true;
    this.#options.log(`Nearby: a device wants to connect — code ${this.#expected.code}`);
  }

  #take(channel: DataChannel) {
    // A gitui guest opens one channel, with the contract's label; anything else isn't one.
    if (this.#channel || channel.label !== DATA_CHANNEL_LABEL) return this.close();

    this.#channel = channel;
    channel.listen({
      message: (data) => this.#receive(channel, data),
      close: () => this.close(),
    });
    if (!this.#options.resuming) this.#showCode();
  }

  #receive(channel: DataChannel, data: string | Uint8Array) {
    if (this.#bridge) return this.#bridge.receive(data);
    const expected = this.#expected;
    if (this.#state !== "authenticating" || !expected) return;
    const opening = parseOpening(data);
    if (opening === null) return this.close("Nearby: a device sent requests before its code");

    const first = !this.#opened;
    this.#opened = true;
    // The token this guest resumes with, if it is a live one.
    let resumed: string | null = null;
    if (opening.t === "resume") {
      const at = findProof(opening.proof, expected.tokenProofs);
      resumed = at >= 0 ? expected.tokens[at] : null;
    }
    const send = (message: ChannelMessage) => channel.send(JSON.stringify(message));
    // A token from a CLI run that ended, or one this run forgot: the guest asks for the code on
    // this channel next, with every attempt left. Tokens are too long to guess, so only this
    // first resume is free; another one counts as a failed attempt.
    if (first && opening.t === "resume" && resumed === null) {
      send({ t: "auth-fail", attemptsLeft: this.#attempts.left });
      this.#showCode();
      return;
    }
    const verdict = this.#attempts.check(
      opening.t === "auth" ? safeEqual(opening.proof, expected.codeProof) : resumed !== null,
    );
    if (verdict.ok) {
      clearTimeout(this.#timer);
      this.#state = "open";
      this.#bridge = new Bridge(channel, this.#options.fetch);
      // A resumed guest keeps its token: it is as good as it was.
      send({ t: "auth-ok" });
      send({ t: "session", token: resumed ?? this.#options.tokens.issue() });
      this.#options.log(resumed ? "Nearby: a device reconnected" : "Nearby: device connected");
      return;
    }
    send({ t: "auth-fail", attemptsLeft: verdict.attemptsLeft });
    if (verdict.attemptsLeft > 0) {
      // Whoever sent a code without being shown one gets it now (a guest that said it would
      // resume and then didn't).
      this.#showCode();
      return;
    }
    // Let the last auth-fail leave before the channel closes.
    this.#expected = null;
    void channel
      .drain(0)
      .then(() =>
        this.close(`Nearby: refused a device that entered a wrong code ${AUTH_ATTEMPTS} times`),
      );
  }
}
