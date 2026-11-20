// What a guest must prove before its data channel serves anything (the contract's step 3): the
// code this machine printed for its connection, through CPace, or a resume token from an
// earlier one. The protocol itself is @gitui/shared's nearby-pake.ts; this is the host's part.
import { randomBytes, randomInt } from "node:crypto";
import { AUTH_ATTEMPTS, AUTH_CODE_DIGITS, type Fingerprints, sdpFingerprint } from "@gitui/shared";

/** A fresh code of AUTH_CODE_DIGITS digits, leading zeros included. */
export const newCode = () =>
  String(randomInt(10 ** AUTH_CODE_DIGITS)).padStart(AUTH_CODE_DIGITS, "0");

/** This run's HostInfo.key: 16 random bytes, base64url (22 characters). */
export const newHostKey = () => randomBytes(16).toString("base64url");

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

export type Verdict = { ok: true } | { ok: false; attemptsLeft: number };

/**
 * Counts a guest's tries, codes and resumes alike: after AUTH_ATTEMPTS failures every try fails,
 * right or not.
 */
export class Attempts {
  #left = AUTH_ATTEMPTS;

  /** The tries left. */
  get left() {
    return this.#left;
  }

  check(ok: boolean): Verdict {
    if (this.#left > 0 && ok) return { ok: true };
    return { ok: false, attemptsLeft: this.spend() };
  }

  /**
   * Spends one try up front and returns the tries left: CPace tells the guest whether its code
   * was right as soon as the host answers its `pake`, so the answer is the attempt.
   */
  spend() {
    this.#left = Math.max(0, this.#left - 1);
    return this.#left;
  }
}
