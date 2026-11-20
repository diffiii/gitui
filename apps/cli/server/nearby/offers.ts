// Which guests' offers the host takes, decided without I/O. Every offer gets a fresh code and
// AUTH_ATTEMPTS tries, so offers are capped: those still proving themselves (MAX_PENDING) and
// those per minute (MAX_OFFERS_PER_MINUTE). While the pairing budget (auth.ts) is out, offers
// are refused too, unless they say they resume: a paired device needs no code, and a failed
// resume is refused then. Refusals are said to the guest at most MAX_REFUSALS_PER_WINDOW times
// per RATE_WINDOW, so guests' offers can't spend this host's budget at the rendezvous.
import {
  MAX_OFFERS_PER_MINUTE,
  MAX_PENDING,
  MAX_REFUSALS_PER_WINDOW,
  RATE_WINDOW,
  type RefusalReason,
} from "@gitui/shared";
import type { PairingBudget } from "./auth.ts";

/** Said once when offers are refused, until one gets through again. */
export const BUSY_LINE = "Nearby: ignoring connection requests, too many at once";

export type Admission =
  | { ok: true }
  /**
   * `line`: what to print, if anything (the budget prints its own line, BUDGET_LINE). `tell`:
   * whether to send the guest `refused`, or ignore the offer.
   */
  | { ok: false; reason: RefusalReason; line: string | null; tell: boolean };

export class OfferLimiter {
  readonly #budget: PairingBudget;
  readonly #now: () => number;
  /** When the offers taken in the last minute arrived. */
  readonly #times: number[] = [];
  /** When the refusals told in the last RATE_WINDOW were. */
  readonly #refusals: number[] = [];
  #said = false;

  constructor(budget: PairingBudget, now: () => number = Date.now) {
    this.#budget = budget;
    this.#now = now;
  }

  /**
   * Whether to take an offer. `pending`: the guests still proving themselves, besides one this
   * offer replaces; `resume`: the offer says it resumes.
   */
  admit(pending: number, resume: boolean): Admission {
    const now = this.#now();
    while (this.#times.length && this.#times[0]! <= now - 60_000) this.#times.shift();
    const refusal =
      pending >= MAX_PENDING
        ? ({ reason: "busy", line: BUSY_LINE } as const)
        : this.#times.length >= MAX_OFFERS_PER_MINUTE
          ? ({ reason: "rate-limited", line: BUSY_LINE } as const)
          : !resume && this.#budget.exhausted
            ? ({ reason: "rate-limited", line: null } as const)
            : null;
    if (refusal) {
      const line = refusal.line && !this.#said ? refusal.line : null;
      if (refusal.line) this.#said = true;
      return { ok: false, reason: refusal.reason, line, tell: this.#tell(now) };
    }
    this.#said = false;
    this.#times.push(now);
    return { ok: true };
  }

  /**
   * Whether a refusal may be told: at most MAX_REFUSALS_PER_WINDOW in any RATE_WINDOW ms, so in
   * the rendezvous's fixed windows too.
   */
  #tell(now: number) {
    while (this.#refusals.length && this.#refusals[0]! <= now - RATE_WINDOW) this.#refusals.shift();
    if (this.#refusals.length >= MAX_REFUSALS_PER_WINDOW) return false;
    this.#refusals.push(now);
    return true;
  }
}
