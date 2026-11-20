// What a guest must prove before its data channel serves anything (the contract's step 3): the
// code this machine printed for its connection, through CPace, or a resume token from an
// earlier one. The protocol itself is @gitui/shared's nearby-pake.ts; this is the host's part.
import { randomBytes, randomInt } from "node:crypto";
import { AUTH_ATTEMPTS, AUTH_CODE_DIGITS, type Fingerprints, sdpFingerprint } from "@gitui/shared";

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
 * connection. Over PAIRING_BUDGET in PAIRING_WINDOW, no `pake` is answered and offers are
 * refused (OfferLimiter). Successful pairings count too, and reset nothing.
 */
export const PAIRING_BUDGET = 10;
export const PAIRING_WINDOW = 10 * 60_000;

/** The line printed when the pairing budget runs out. */
export const BUDGET_LINE =
  "Nearby: too many pairing attempts in the last 10 minutes, refusing new devices for now";

export interface PairingBudgetOptions {
  /** Called when a spend takes the last attempt: once each time the budget runs out. */
  onExhausted?: () => void;
  now?: () => number;
  limit?: number;
  window?: number;
}

/** The process-wide pairing budget (PAIRING_BUDGET per rolling PAIRING_WINDOW). */
export class PairingBudget {
  readonly #times: number[] = [];
  readonly #onExhausted: () => void;
  readonly #now: () => number;
  readonly #limit: number;
  readonly #window: number;

  constructor({
    onExhausted = () => {},
    now = Date.now,
    limit = PAIRING_BUDGET,
    window = PAIRING_WINDOW,
  }: PairingBudgetOptions = {}) {
    this.#onExhausted = onExhausted;
    this.#now = now;
    this.#limit = limit;
    this.#window = window;
  }

  /** The attempts left in the current window. */
  get left() {
    const since = this.#now() - this.#window;
    while (this.#times.length && this.#times[0]! <= since) this.#times.shift();
    return this.#limit - this.#times.length;
  }

  get exhausted() {
    return this.left === 0;
  }

  /** Takes one attempt; false if none is left. */
  spend() {
    if (this.exhausted) return false;
    this.#times.push(this.#now());
    if (this.exhausted) this.#onExhausted();
    return true;
  }
}

/** What the host does about a guest's authentication message (Gatekeeper). */
export type Step =
  /** Answer the `pake` (hostRespond); this run spent an attempt. */
  | { kind: "answer" }
  /** The guest proved itself, with its code or a resume token. */
  | { kind: "open"; via: "code" | "resume" }
  /** Send `auth-fail` and show the code: the guest may try again. */
  | { kind: "fail"; attemptsLeft: number }
  /**
   * Send `auth-fail` with no attempts left and close the channel: the guest used its attempts,
   * or the pairing budget ran out.
   */
  | { kind: "refuse"; why: "attempts" | "budget" }
  /** A confirmation without a run: close the channel. */
  | { kind: "violation" };

/**
 * One guest's authentication, decided without I/O: its attempts, the pairing budget, codes and
 * resumes. GuestSession (peer.ts) does the cryptography and sends what each step says.
 *
 * Every `pake` answered spends one of AUTH_ATTEMPTS attempts and one of the budget's. The first
 * `resume` is free if it fails (tokens can't be guessed; the attempts guard the code), unless
 * the budget is out, since the code it would show couldn't be used; any later one that fails
 * spends an attempt. After the last attempt every message fails, right or not.
 */
export class Gatekeeper {
  readonly #budget: PairingBudget;
  #left = AUTH_ATTEMPTS;
  /** Whether the guest sent its opening (`pake` or `resume`) yet. */
  #opened = false;
  /** Whether a `pake` was answered and waits for its confirmation. */
  #running = false;

  constructor(budget: PairingBudget) {
    this.#budget = budget;
  }

  get attemptsLeft() {
    return this.#left;
  }

  /** The guest's `pake`. A new one gives up on the run before it, whose attempt is spent. */
  pake(): Step {
    this.#opened = true;
    this.#running = false;
    if (this.#left === 0) return { kind: "refuse", why: "attempts" };
    if (!this.#budget.spend()) return { kind: "refuse", why: "budget" };
    this.#left--;
    this.#running = true;
    return { kind: "answer" };
  }

  /**
   * The end of the run: `ok` if the guest's `pake-confirm` checked out; false for a tag that
   * didn't, a `pake-fail`, or a share hostRespond couldn't use.
   */
  confirm(ok: boolean): Step {
    if (!this.#running) return { kind: "violation" };
    this.#running = false;
    return ok ? { kind: "open", via: "code" } : this.#fail();
  }

  /** The guest's `resume`; `valid` if its proof matched a live token. */
  resume(valid: boolean): Step {
    const first = !this.#opened;
    this.#opened = true;
    this.#running = false;
    if (valid && this.#left > 0) return { kind: "open", via: "resume" };
    if (first && !valid) {
      return this.#budget.exhausted
        ? { kind: "refuse", why: "budget" }
        : { kind: "fail", attemptsLeft: this.#left };
    }
    this.#left = Math.max(0, this.#left - 1);
    return this.#fail();
  }

  #fail(): Step {
    return this.#left > 0
      ? { kind: "fail", attemptsLeft: this.#left }
      : { kind: "refuse", why: "attempts" };
  }
}
