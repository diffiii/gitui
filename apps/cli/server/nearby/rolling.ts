// A rate limit over a rolling window: at most `limit` takes in any `window` ms. The pairing
// budget (auth.ts) and the offer limits (offers.ts) count with it.

export class RollingWindow {
  /** When each take in the window happened, oldest first (and some older, until `take`). */
  readonly #times: number[] = [];
  readonly #limit: number;
  readonly #window: number;
  readonly #now: () => number;

  constructor(limit: number, window: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#window = window;
    this.#now = now;
  }

  /** The takes left now. */
  get left() {
    return this.#limit - (this.#times.length - this.#expired());
  }

  /** When a take will fit: now if one is left, else once the oldest in the window leaves it. */
  get freesAt() {
    if (this.left > 0) return this.#now();
    return this.#times[this.#expired()]! + this.#window;
  }

  /** Takes one; false if none is left. */
  take() {
    this.#times.splice(0, this.#expired());
    if (this.#times.length >= this.#limit) return false;
    this.#times.push(this.#now());
    return true;
  }

  /** How many of the oldest times have left the window. */
  #expired() {
    const since = this.#now() - this.#window;
    const first = this.#times.findIndex((time) => time > since);
    return first === -1 ? this.#times.length : first;
  }
}
