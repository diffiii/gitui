// One guest's connection, from its offer to its end: answers the offer, trickles candidates,
// takes the guest's data channel, runs CPace for its code or checks its resume token (auth.ts,
// @gitui/shared's nearby-pake.ts) and then hands the channel to the bridge. Nothing reaches the
// bridge before the guest proved itself.
import {
  AUTH_ATTEMPTS,
  decodeChannelMessage,
  DATA_CHANNEL_LABEL,
  type Fingerprints,
  hostFinish,
  type HostMessage,
  type HostPake,
  hostRespond,
  type IceCandidate,
  resumeAnswer,
  type SignalData,
} from "@gitui/shared";
import { Attempts, fingerprints, newCode, type Tokens } from "./auth.ts";
import { Bridge, type Fetch } from "./bridge.ts";
import { type AnsweringPeer, createAnsweringPeer, type DataChannel } from "./webrtc.ts";

/** How long a guest has, from its offer, to prove itself. */
export const AUTH_TIMEOUT = 60_000;

/** What the host sends a guest about its offer: its answer and candidates. */
export type HostSignal =
  | { kind: "answer"; sdp: string }
  | { kind: "candidate"; candidate: IceCandidate };

export interface GuestOptions {
  offerSdp: string;
  /** The offer's id, which every signal of this session carries (SignalData). */
  offerId: string;
  /**
   * The offer said the guest will `resume` (SignalData): the code is printed only if that
   * fails, so reconnections print nothing. Otherwise it is printed once the channel opens.
   */
  resuming?: boolean;
  stunUrls: string[];
  /** Sends a signal of this offer's to the guest through the rendezvous service. */
  signal: (data: Extract<SignalData, { kind: "answer" | "candidate" }>) => void;
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

/** What the guest's proofs are checked against, once the answer is made. */
interface Expected {
  code: string;
  prints: Fingerprints;
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
  /** The CPace run waiting for the guest's `pake-confirm`. */
  #pake: HostPake | null = null;
  #codeShown = false;
  #channel: DataChannel | null = null;
  #bridge: Bridge | null = null;

  constructor(options: GuestOptions) {
    this.#options = options;
    this.#peer = createAnsweringPeer(options.stunUrls, {
      candidate: (candidate) =>
        options.signal({ kind: "candidate", offerId: options.offerId, candidate }),
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

  /** Adds a candidate the guest trickled for offer `offerId`, once the offer is applied. */
  addCandidate(offerId: string, candidate: IceCandidate) {
    // A candidate of an earlier offer of this guest's belongs to a connection that is gone.
    if (offerId !== this.#options.offerId) return;
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
    const { offerSdp, offerId, signal } = this.#options;
    try {
      const answerSdp = await this.#peer.answer(offerSdp);
      const prints = fingerprints(offerSdp, answerSdp);
      // (A session closed meanwhile stays closed, and quiet.)
      if (!prints) {
        return this.close("Nearby: refused an offer without exactly one SHA-256 DTLS fingerprint");
      }
      if (this.#state === "closed") return;
      this.#expected = { code: newCode(), prints };
      this.#state = "authenticating";
      signal({ kind: "answer", offerId, sdp: answerSdp });
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
    const incoming = decodeChannelMessage(data, "guest");
    const message = incoming.kind === "message" ? incoming.message : null;
    const send = (message: HostMessage) => channel.send(JSON.stringify(message));

    switch (message?.t) {
      case "resume":
        return this.#resume(channel, expected, message, send);
      case "pake": {
        this.#opened = true;
        // A new `pake` gives up on the run before it, whose attempt is already spent.
        this.#pake = null;
        if (this.#attempts.left === 0) {
          // Its last attempt went on the run it gave up on.
          send({ t: "auth-fail", attemptsLeft: 0 });
          return this.#refuse(channel);
        }
        const left = this.#attempts.spend();
        const answer = hostRespond(expected.code, expected.prints, message.y);
        // Whoever sent a code without being shown one gets it now (a guest that said it would
        // resume and then didn't).
        this.#showCode();
        if (!answer) {
          send({ t: "auth-fail", attemptsLeft: left });
          if (left === 0) this.#refuse(channel);
          return;
        }
        this.#pake = answer.state;
        return send(answer.message);
      }
      case "pake-confirm":
      case "pake-fail": {
        const run = this.#pake;
        this.#pake = null;
        if (!run) return this.close("Nearby: a device broke the pairing protocol");
        if (message.t === "pake-confirm" && hostFinish(run, message.confirm)) {
          this.#open(channel, null);
          send({ t: "auth-ok" });
          send({ t: "session", token: this.#options.tokens.issue() });
          return;
        }
        send({ t: "auth-fail", attemptsLeft: this.#attempts.left });
        if (this.#attempts.left === 0) this.#refuse(channel);
        return;
      }
      default:
        return this.close("Nearby: a device sent requests before its code");
    }
  }

  #resume(
    channel: DataChannel,
    expected: Expected,
    message: { nonce: string; proof: string },
    send: (message: HostMessage) => void,
  ) {
    const first = !this.#opened;
    this.#opened = true;
    this.#pake = null;
    const answer = resumeAnswer(this.#options.tokens.list(), expected.prints, message);
    // A token from a CLI run that ended, or one this run forgot: the guest asks for the code on
    // this channel next, with every attempt left. Tokens are too long to guess, so only this
    // first resume is free; another one counts as a failed attempt.
    if (first && answer === null) {
      send({ t: "auth-fail", attemptsLeft: this.#attempts.left });
      this.#showCode();
      return;
    }
    const verdict = this.#attempts.check(answer !== null);
    if (verdict.ok && answer) {
      // The guest keeps its token: it is as good as it was. `resume-ok` proves this host holds it.
      this.#open(channel, "Nearby: a device reconnected");
      send(answer.message);
      return;
    }
    if (verdict.ok) return;
    send({ t: "auth-fail", attemptsLeft: verdict.attemptsLeft });
    if (verdict.attemptsLeft > 0) this.#showCode();
    else this.#refuse(channel);
  }

  /** The guest proved itself: requests go to the bridge from now on. */
  #open(channel: DataChannel, line: string | null) {
    clearTimeout(this.#timer);
    this.#state = "open";
    this.#bridge = new Bridge(channel, this.#options.fetch);
    this.#options.log(line ?? "Nearby: device connected");
  }

  /** Out of attempts: the last `auth-fail` leaves, then the channel closes. */
  #refuse(channel: DataChannel) {
    this.#expected = null;
    this.#pake = null;
    void channel
      .drain(0)
      .then(() =>
        this.close(`Nearby: refused a device that entered a wrong code ${AUTH_ATTEMPTS} times`),
      );
  }
}
