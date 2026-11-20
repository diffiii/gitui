// What a guest must prove before its data channel serves anything (the contract's step 3): the
// code this machine printed for its connection, through CPace, or a resume token from an
// earlier one. The protocol itself is @gitui/shared's nearby-pake.ts; this is the host's part.
import { randomBytes, randomInt } from "node:crypto";
import { AUTH_ATTEMPTS, AUTH_CODE_DIGITS, type Fingerprints, sdpFingerprint } from "@gitui/shared";
import { RollingWindow } from "./rolling.ts";

/** A fresh code of AUTH_CODE_DIGITS digits, leading zeros included. */
export const newCode = () =>
  String(randomInt(10 ** AUTH_CODE_DIGITS)).padStart(AUTH_CODE_DIGITS, "0");

/**
 * This run's hello secret (HOST_SECRET): 32 random bytes, base64url (43 characters). Guests see
 * only its hostKey, so nobody else can take this host's key at the rendezvous.
 */
export const newHostSecret = () => randomBytes(32).toString("base64url");

/** A resume token: 32 random bytes, base64url. */
export const newToken = () => randomBytes(32).toString("base64url");

/** The most resume tokens kept; pairing more devices forgets the oldest. */
export const MAX_TOKENS = 32;

/** The resume tokens handed out while this CLI runs; they live in memory only. */
export class Tokens {
  readonly #tokens: string[] = [];

  /** A new token for a guest that just entered its code. */
  issue() {
    const token = newToken();
    this.#tokens.push(token);
    if (this.#tokens.length > MAX_TOKENS) this.#tokens.shift();
    return token;
  }

  /** Every live token, oldest first. */
  list(): readonly string[] {
    return this.#tokens;
  }
}

/**
 * The DTLS fingerprints of the guest's offer and this side's answer, which CPace and the resume
 * proofs are bound to, or null unless each SDP has exactly one SHA-256 one.
 */
export function fingerprints(offerSdp: string, answerSdp: string): Fingerprints | null {
  const guest = sdpFingerprint(offerSdp);
  const host = sdpFingerprint(answerSdp);
  return guest && host ? { guest, host } : null;
}

/**
 * The pairing attempts this process answers, across every connection: each `pake` the host
 * answers is a guess at a code, and AUTH_ATTEMPTS alone would start over with every new
 * connection. Over PAIRING_BUDGET in PAIRING_WINDOW, no `pake` is answered and offers that don't
 * resume are refused as `pairing-locked` (OfferLimiter). Successful pairings count too, and
 * reset nothing.
 */
export const PAIRING_BUDGET = 10;
export const PAIRING_WINDOW = 10 * 60_000;

/** "HH:MM" of `time`, in local time. */
const clock = (time: number) => new Date(time).toTimeString().slice(0, 5);

/** The line printed when the pairing budget runs out, until `until`. */
export const lockoutLine = (until: number) =>
  `Nearby: too many pairing attempts in the last ${PAIRING_WINDOW / 60_000} minutes, so ` +
  `someone may be guessing codes. New devices can't pair until ${clock(until)}; paired ` +
  "devices can still reconnect";

export interface PairingBudgetOptions {
  /**
   * Called when a spend takes the last attempt, with when one frees up again: once per lockout,
   * which lasts until a whole window passes without attempts. Attempts that free up during a
   * lockout and are spent again (as a sustained attack does) don't call it again.
   */
  onLockout?: (until: number) => void;
  now?: () => number;
  limit?: number;
  window?: number;
}

/** The process-wide pairing budget (PAIRING_BUDGET per rolling PAIRING_WINDOW). */
export class PairingBudget {
  readonly #attempts: RollingWindow;
  readonly #onLockout: (until: number) => void;
  readonly #limit: number;
  #locked = false;

  constructor({
    onLockout = () => {},
    now = Date.now,
    limit = PAIRING_BUDGET,
    window = PAIRING_WINDOW,
  }: PairingBudgetOptions = {}) {
    this.#attempts = new RollingWindow(limit, window, now);
    this.#onLockout = onLockout;
    this.#limit = limit;
  }

  /** The attempts left in the current window. */
  get left() {
    return this.#attempts.left;
  }

  get exhausted() {
    return this.left === 0;
  }

  /** Takes one attempt; false if none is left. */
  spend() {
    // A whole window without attempts ends a lockout.
    if (this.left === this.#limit) this.#locked = false;
    if (!this.#attempts.take()) return false;
    if (this.exhausted && !this.#locked) {
      this.#locked = true;
      this.#onLockout(this.#attempts.freesAt);
    }
    return true;
  }
}

type Fail = {
  /** Send `auth-fail` and show the code: the guest may try again. */
  kind: "fail";
  attemptsLeft: number;
};
type Refuse = {
  /**
   * Send `auth-fail` with no attempts left and close the channel: the guest used its attempts,
   * or the pairing budget ran out.
   */
  kind: "refuse";
  why: "attempts" | "budget";
};

/** What the host does about a guest's `pake` (Gatekeeper.pake). */
export type PakeStep<Run> =
  /** Send the run's answer; this run spent an attempt, and waits for its confirmation. */
  { kind: "answer"; run: Run } | Fail | Refuse;

/** How a guest's authentication went, after a confirmation or a resume. */
export type Outcome =
  /** The guest proved itself: with its code after `confirm`, its token after `resume`. */
  | { kind: "open" }
  | Fail
  | Refuse
  /** A confirmation without a run: close the channel. */
  | { kind: "violation" };

/**
 * One guest's authentication, decided without I/O: its attempts, the pairing budget, codes,
 * resumes, and the CPace run (a `Run`) waiting for its confirmation. GuestSession (peer.ts) does
 * the cryptography and sends what each step says.
 *
 * Every `pake` answered spends one of AUTH_ATTEMPTS attempts and one of the budget's. The first
 * `resume` is free if it fails (tokens can't be guessed; the attempts guard the code), unless
 * the budget is out, since the code it would show couldn't be used; any later one that fails
 * spends an attempt. After the last attempt every message fails, right or not.
 */
export class Gatekeeper<Run> {
  readonly #budget: PairingBudget;
  #left = AUTH_ATTEMPTS;
  /** Whether the guest sent its opening (`pake` or `resume`) yet. */
  #opened = false;
  /** The run answered that waits for its confirmation. */
  #run: Run | null = null;

  constructor(budget: PairingBudget) {
    this.#budget = budget;
  }

  get attemptsLeft() {
    return this.#left;
  }

  /**
   * The guest's `pake`: `respond` answers it (hostRespond), or returns null for a share it can't
   * use, which is a failed attempt. It is called only if the pake may be answered. A new `pake`
   * gives up on the run before it, whose attempt is spent.
   */
  pake(respond: () => Run | null): PakeStep<Run> {
    this.#opened = true;
    this.#run = null;
    if (this.#left === 0) return { kind: "refuse", why: "attempts" };
    if (!this.#budget.spend()) return { kind: "refuse", why: "budget" };
    this.#left--;
    this.#run = respond();
    return this.#run === null ? this.#fail() : { kind: "answer", run: this.#run };
  }

  /**
   * The end of the run: `check` says whether the guest's `pake-confirm` checks out against it.
   * A `pake-fail` is a check that fails.
   */
  confirm(check: (run: Run) => boolean): Outcome {
    const run = this.#run;
    if (run === null) return { kind: "violation" };
    this.#run = null;
    return check(run) ? { kind: "open" } : this.#fail();
  }

  /** The guest's `resume`; `valid` if its proof matched a live token. */
  resume(valid: boolean): Outcome {
    const first = !this.#opened;
    this.#opened = true;
    this.#run = null;
    if (valid && this.#left > 0) return { kind: "open" };
    if (first && !valid) {
      return this.#budget.exhausted
        ? { kind: "refuse", why: "budget" }
        : { kind: "fail", attemptsLeft: this.#left };
    }
    this.#left = Math.max(0, this.#left - 1);
    return this.#fail();
  }

  #fail(): Fail | Refuse {
    return this.#left > 0
      ? { kind: "fail", attemptsLeft: this.#left }
      : { kind: "refuse", why: "attempts" };
  }
}
