// What a guest must prove before its data channel serves anything (the contract's step 3): the
// code this machine printed for its connection, or a resume token from an earlier one.
import { randomBytes, randomInt } from "node:crypto";
import { AUTH_ATTEMPTS, AUTH_CODE_DIGITS, sdpFingerprint } from "@gitui/shared";
import { safeEqual } from "../access.ts";

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
 * The DTLS fingerprints of the guest's offer and this side's answer, which every proof is bound
 * to (authProof), or null if either SDP has none.
 */
export function fingerprints(offerSdp: string, answerSdp: string) {
  const guest = sdpFingerprint(offerSdp);
  const host = sdpFingerprint(answerSdp);
  return guest && host ? { guest, host } : null;
}

/** The index of `proof` in `expected`, or -1; compares with every one, in constant time. */
export function findProof(proof: string, expected: readonly string[]) {
  let found = -1;
  expected.forEach((candidate, i) => {
    if (safeEqual(proof, candidate)) found = i;
  });
  return found;
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
    this.#left = Math.max(0, this.#left - 1);
    return { ok: false, attemptsLeft: this.#left };
  }
}

/** A guest's opening message: an `auth` with a code's proof or a `resume` with a token's. */
export type Opening = { t: "auth" | "resume"; proof: string };

/** The opening in a channel message, or null if it isn't an `auth` or `resume` message. */
export function parseOpening(data: string | Uint8Array): Opening | null {
  if (typeof data !== "string") return null;
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null) return null;
    const { t, proof } = message as Record<string, unknown>;
    return (t === "auth" || t === "resume") && typeof proof === "string" ? { t, proof } : null;
  } catch {
    return null;
  }
}
