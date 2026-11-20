// Which guests' offers the host takes, decided without I/O. Every offer gets a fresh code and
// AUTH_ATTEMPTS tries, so offers are capped: those still proving themselves (MAX_PENDING) and
// those per minute (MAX_OFFERS_PER_MINUTE). While the pairing budget (auth.ts) is out, offers
// are refused as `pairing-locked` too, unless they say they resume: a paired device needs no
// code, and a failed resume is refused then. Refusals are said to the guest at most
// MAX_REFUSALS_PER_WINDOW times per RATE_WINDOW, so guests' offers can't spend this host's
// budget at the rendezvous.
import {
  MAX_OFFERS_PER_MINUTE,
  MAX_PENDING,
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
  readonly #offers: RollingWindow;
  readonly #refusals: RollingWindow;
  #said = false;

  constructor(budget: PairingBudget, now: () => number = Date.now) {
    this.#budget = budget;
    this.#offers = new RollingWindow(MAX_OFFERS_PER_MINUTE, 60_000, now);
    // At most MAX_REFUSALS_PER_WINDOW in any RATE_WINDOW ms, so in the rendezvous's fixed
    // windows too.
    this.#refusals = new RollingWindow(MAX_REFUSALS_PER_WINDOW, RATE_WINDOW, now);
  }

  /**
   * Whether to take an offer. `pending`: the guests still proving themselves, besides one this
   * offer replaces; `resume`: the offer says it resumes.
   */
  admit(pending: number, resume: boolean): Admission {
    // The first that applies is the reason.
    const refusals: { applies: boolean; reason: WireRefusalReason; line: string | null }[] = [
      { applies: pending >= MAX_PENDING, reason: "busy", line: BUSY_LINE },
      { applies: this.#offers.left === 0, reason: "rate-limited", line: BUSY_LINE },
      { applies: !resume && this.#budget.exhausted, reason: "pairing-locked", line: null },
    ];
    const refusal = refusals.find((r) => r.applies);
    if (refusal) {
      const line = refusal.line && !this.#said ? refusal.line : null;
      if (refusal.line) this.#said = true;
      return { ok: false, reason: refusal.reason, line, tell: this.#refusals.take() };
    }
    this.#said = false;
    this.#offers.take();
    return { ok: true };
  }
}
