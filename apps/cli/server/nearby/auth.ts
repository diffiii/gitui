// The code a guest must enter before its data channel serves anything (the contract's step 3).
import { randomInt } from "node:crypto";
import { AUTH_ATTEMPTS, AUTH_CODE_DIGITS, authProof, sdpFingerprint } from "@gitui/shared";
import { safeEqual } from "../access.ts";

/** A fresh code of AUTH_CODE_DIGITS digits, leading zeros included. */
export const newCode = () =>
  String(randomInt(10 ** AUTH_CODE_DIGITS)).padStart(AUTH_CODE_DIGITS, "0");

/**
 * The proof a guest that knows `code` sends, bound to the DTLS fingerprints of the guest's offer
 * and this side's answer. Null if either SDP has no fingerprint.
 */
export async function expectedProof(code: string, offerSdp: string, answerSdp: string) {
  const guest = sdpFingerprint(offerSdp);
  const host = sdpFingerprint(answerSdp);
  return guest && host ? authProof(code, guest, host) : null;
}

export type Verdict = { ok: true } | { ok: false; attemptsLeft: number };

/** Checks proofs against `expected` in constant time, failing every one after AUTH_ATTEMPTS misses. */
export function proofChecker(expected: string): (proof: string) => Verdict {
  let attemptsLeft = AUTH_ATTEMPTS;
  return (proof) => {
    if (attemptsLeft > 0 && safeEqual(proof, expected)) return { ok: true };
    attemptsLeft = Math.max(0, attemptsLeft - 1);
    return { ok: false, attemptsLeft };
  };
}

/** The proof in a channel message if it is an `auth` message, else null. */
export function parseAuth(data: string | Uint8Array): string | null {
  if (typeof data !== "string") return null;
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null) return null;
    const { t, proof } = message as Record<string, unknown>;
    return t === "auth" && typeof proof === "string" ? proof : null;
  } catch {
    return null;
  }
}
