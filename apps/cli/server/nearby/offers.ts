// Which guests' offers the host takes, decided without I/O. Every offer gets a fresh code and
// AUTH_ATTEMPTS tries, so offers are capped: those still proving themselves (MAX_PENDING) and
// those per minute (MAX_OFFERS_PER_MINUTE). Offers that say they resume have limits of their
// own (MAX_PENDING_RESUMES, MAX_RESUMES_PER_MINUTE), so offers for a code can't keep paired
// devices out. While the pairing budget (auth.ts) is out, offers
// are refused as `pairing-locked` too, unless they say they resume: a paired device needs no
// code, and a failed resume is refused then. Refusals are said to the guest at most
// MAX_REFUSALS_PER_WINDOW times per RATE_WINDOW, so guests' offers can't spend this host's
// budget at the rendezvous.
import {
  MAX_OFFERS_PER_MINUTE,
  MAX_PENDING,
  MAX_PENDING_RESUMES,
  MAX_RESUMES_PER_MINUTE,
  MAX_REFUSALS_PER_WINDOW,
  RATE_WINDOW,
  type WireRefusalReason,
} from "@gitui/shared";
import type { PairingBudget } from "./auth.ts";
import { RollingWindow } from "./rolling.ts";

/** Said once when offers are refused, until one gets through again. */
export const BUSY_LINE = "Nearby: ignoring connection requests, too many at once";

export type Admission =
  | { ok: true }
  /**
   * `line`: what to print, if anything (the budget prints its own line, lockoutLine). `tell`:
   * whether to send the guest `refused`, or ignore the offer.
   */
  | { ok: false; reason: WireRefusalReason; line: string | null; tell: boolean };

export class OfferLimiter {
  readonly #budget: PairingBudget;
  /** Offers taken that don't resume, and those that do. */
  readonly #codes: RollingWindow;
  readonly #resumes: RollingWindow;
  readonly #refusals: RollingWindow;
  #said = false;

  constructor(budget: PairingBudget, now: () => number = Date.now) {
    this.#budget = budget;
    const codes = MAX_OFFERS_PER_MINUTE - MAX_RESUMES_PER_MINUTE;
    this.#codes = new RollingWindow(codes, 60_000, now);
    this.#resumes = new RollingWindow(MAX_RESUMES_PER_MINUTE, 60_000, now);
    // At most MAX_REFUSALS_PER_WINDOW in any RATE_WINDOW ms, so in the rendezvous's fixed
    // windows too.
    this.#refusals = new RollingWindow(MAX_REFUSALS_PER_WINDOW, RATE_WINDOW, now);
  }

  /**
   * Whether to take an offer. `resume`: the offer says it resumes. `pending`: the guests of the
   * same kind (resuming or not) still proving themselves, besides one this offer replaces.
   */
  admit(pending: number, resume: boolean): Admission {
    const offers = resume ? this.#resumes : this.#codes;
    const maxPending = resume ? MAX_PENDING_RESUMES : MAX_PENDING;
    // The first that applies is the reason.
    const refusals: { applies: boolean; reason: WireRefusalReason; line: string | null }[] = [
      { applies: pending >= maxPending, reason: "busy", line: BUSY_LINE },
      { applies: offers.left === 0, reason: "rate-limited", line: BUSY_LINE },
      { applies: !resume && this.#budget.exhausted, reason: "pairing-locked", line: null },
    ];
    const refusal = refusals.find((r) => r.applies);
    if (refusal) {
      const line = refusal.line && !this.#said ? refusal.line : null;
      if (refusal.line) this.#said = true;
      return { ok: false, reason: refusal.reason, line, tell: this.#refusals.take() };
    }
    this.#said = false;
    offers.take();
    return { ok: true };
  }
}
