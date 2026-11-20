// One guest's connection, from its offer to its end: answers the offer (or refuses one it can't
// use), trickles candidates, takes the guest's data channel, runs CPace for its code or checks its
// resume token (@gitui/shared's nearby-pake.ts) as auth.ts's Gatekeeper decides, and then hands
// the channel to the bridge. Nothing reaches the bridge before the guest proved itself. An error
// in one of its callbacks closes the session, not the process.
import {
  AUTH_ATTEMPTS,
  decodeChannelMessage,
  DATA_CHANNEL_LABEL,
  type Fingerprints,
  hostFinish,
  type HostMessage,
  hostRespond,
  type IceCandidate,
  MAX_LOCAL_CANDIDATES,
  resumeAnswer,
  type SentSignal,
} from "@gitui/shared";
import {
  fingerprints,
  Gatekeeper,
  newCode,
  type Outcome,
  type PairingBudget,
  type Tokens,
} from "./auth.ts";
import { Bridge, type Fetch } from "./bridge.ts";
import {
  type AnsweringPeer,
  createAnsweringPeer,
  type DataChannel,
  type PeerEvents,
} from "./webrtc.ts";

/** How long a guest has, from its offer, to prove itself. */
export const AUTH_TIMEOUT = 60_000;

/** The most candidates a guest may trickle for one offer; the rest are ignored. */
export const MAX_REMOTE_CANDIDATES = 32;
// This side trickles at most MAX_LOCAL_CANDIDATES, which the rendezvous's limit for hosts
// counts on (apps/rendezvous/src/network.ts).

/** The line for a connection closed after an error of ours (the session's, or host.ts's). */
export const errorLine = (error: unknown) =>
  `Nearby: closed a connection after an error: ${String(error)}`;

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
  signal: (data: Extract<SentSignal, { kind: "answer" | "candidate" | "refused" }>) => void;
  /** Answers the guest's requests once it is authenticated. */
  fetch: Fetch;
  /** This run's resume tokens: checked for `resume`, added to after a code. */
  tokens: Tokens;
  /** The process-wide pairing budget, which every `pake` answered spends from. */
  budget: PairingBudget;
  /** Prints a line for the person at this machine. */
  log: (line: string) => void;
  /** Called once, when the session ends for any reason. */
  onEnd: () => void;
  authTimeout?: number;
  /** For tests: the peer connection, a werift one (createAnsweringPeer) by default. */
  peer?: (stunUrls: string[], events: PeerEvents) => AnsweringPeer;
}

/** A CPace run answered, waiting for the guest's `pake-confirm`. */
type Run = NonNullable<ReturnType<typeof hostRespond>>;

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
  readonly #gate: Gatekeeper<Run>;
  /** The candidates the guest trickled for this offer. */
  #candidates = 0;
  /** The candidates this side trickled. */
  #localCandidates = 0;
  #state: State = "answering";
  #expected: Expected | null = null;
  #codeShown = false;
  #channel: DataChannel | null = null;
  #bridge: Bridge | null = null;

  constructor(options: GuestOptions) {
    this.#options = options;
    this.#gate = new Gatekeeper(options.budget);
    const createPeer = options.peer ?? createAnsweringPeer;
    this.#peer = createPeer(options.stunUrls, {
      candidate: (candidate) => {
        if (++this.#localCandidates > MAX_LOCAL_CANDIDATES) return;
        options.signal({ kind: "candidate", offerId: options.offerId, candidate });
      },
      channel: (channel) => this.#take(channel),
      closed: () => this.close(),
      error: (error) => this.close(errorLine(error)),
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
    if (++this.#candidates > MAX_REMOTE_CANDIDATES) return;
    void this.#answered.then(() => {
      if (this.#state !== "closed") return this.#peer.addCandidate(candidate);
    });
  }

  /**
   * Ends the session, printing `line` if given. Safe to call more than once, and never throws:
   * each teardown step that throws is logged, and the others still run.
   */
  close(line?: string) {
    if (this.#state === "closed") return;
    const wasOpen = this.#state === "open";
    this.#state = "closed";
    clearTimeout(this.#timer);
    const { log, onEnd } = this.#options;
    try {
      const steps = [
        () => this.#bridge?.close(),
        () => this.#channel?.close(),
        () => this.#peer.close(),
      ];
      for (const step of steps) {
        try {
          step();
        } catch (e) {
          log(errorLine(e));
        }
      }
      if (line) log(line);
      else if (wasOpen) log("Nearby: device disconnected");
    } finally {
      onEnd();
    }
  }

  async #answer() {
    const { offerSdp, offerId, signal } = this.#options;
    try {
      const answerSdp = await this.#peer.answer(offerSdp);
      // A session closed meanwhile stays closed, and quiet.
      if (this.#state === "closed") return;
      const prints = fingerprints(offerSdp, answerSdp);
      if (!prints) {
        return this.#refuseOffer(
          "Nearby: refused an offer without exactly one SHA-256 DTLS fingerprint",
        );
      }
      this.#expected = { code: newCode(), prints };
      this.#state = "authenticating";
      signal({ kind: "answer", offerId, sdp: answerSdp });
    } catch (e) {
      if (this.#state === "closed") return;
      this.#refuseOffer(`Nearby: couldn't answer a device: ${(e as Error).message}`);
    }
  }

  /** Tells the guest its offer is of no use, so it needn't wait for an answer, and ends. */
  #refuseOffer(line: string) {
    const { offerId, signal } = this.#options;
    signal({ kind: "refused", offerId, reason: "bad-offer" });
    this.close(line);
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

    switch (message?.t) {
      case "resume": {
        const answer = resumeAnswer(this.#options.tokens.list(), expected.prints, message);
        const outcome = this.#gate.resume(answer !== null);
        if (outcome.kind !== "open") return this.#do(channel, outcome);
        // The guest keeps its token: it is as good as it was. `resume-ok` proves this host holds
        // it.
        this.#open(channel, "Nearby: a device reconnected");
        if (answer) this.#send(channel, answer.message);
        return;
      }
      case "pake": {
        const step = this.#gate.pake(() => hostRespond(expected.code, expected.prints, message.y));
        if (step.kind !== "answer") return this.#do(channel, step);
        // Whoever sent a code without being shown one gets it now (a guest that said it would
        // resume and then didn't).
        this.#showCode();
        return this.#send(channel, step.run.message);
      }
      case "pake-confirm":
        return this.#do(
          channel,
          this.#gate.confirm((run) => hostFinish(run.state, message.confirm)),
        );
      case "pake-fail":
        return this.#do(
          channel,
          this.#gate.confirm(() => false),
        );
      default:
        return this.close("Nearby: a device sent requests before its code");
    }
  }

  #send(channel: DataChannel, message: HostMessage) {
    channel.send(JSON.stringify(message));
  }

  /** Carries out the Gatekeeper's `outcome`; an `open` one here is by code (resumes open above). */
  #do(channel: DataChannel, outcome: Outcome) {
    switch (outcome.kind) {
      case "open":
        this.#open(channel, null);
        this.#send(channel, { t: "auth-ok" });
        return this.#send(channel, { t: "session", token: this.#options.tokens.issue() });
      case "fail":
        // A refused first resume shows the code: the guest asks for it on this channel next.
        this.#send(channel, { t: "auth-fail", attemptsLeft: outcome.attemptsLeft });
        return this.#showCode();
      case "refuse":
        this.#send(channel, { t: "auth-fail", attemptsLeft: 0 });
        // Out of budget, the budget's own line said why (host.ts).
        return this.#refuse(
          channel,
          outcome.why === "attempts"
            ? `Nearby: refused a device that entered a wrong code ${AUTH_ATTEMPTS} times`
            : undefined,
        );
      case "violation":
        return this.close("Nearby: a device broke the pairing protocol");
    }
  }

  /** The guest proved itself: requests go to the bridge from now on. */
  #open(channel: DataChannel, line: string | null) {
    clearTimeout(this.#timer);
    this.#state = "open";
    this.#bridge = new Bridge(channel, this.#options.fetch);
    this.#options.log(line ?? "Nearby: device connected");
  }

  /** Out of attempts: the last `auth-fail` leaves, then the channel closes. */
  #refuse(channel: DataChannel, line?: string) {
    this.#expected = null;
    void channel.drain(0).then(() => this.close(line));
  }
}
