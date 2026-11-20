// Authentication on the nearby data channel (nearby.ts, step 3): CPace for the code, and HMAC
// proofs both ways for resume tokens. Pure and synchronous: every function takes its state and
// returns the next one, so the CLI (host) and the web app (guest) run the same code, and tests
// run it without a channel.
//
// CPace (draft-irtf-cfrg-cpace-21, primitives in cpace.ts) on ristretto255 with SHA-512,
// initiator-responder mode: the guest is A (initiator), the host is B (responder).
//   PRS = the code, UTF-8.   sid = b"" (see channelId).   ADa = ADb = b"".
//   CI  = lv_cat(PAKE_LABEL, guest fingerprint, host fingerprint) (channelId).
//   ISK = SHA-512(lv_cat("CPaceRistretto255_ISK", sid, K) || lv_cat(Ya, ADa) || lv_cat(Yb, ADb))
// Key confirmation is gitui's own construction, not the one in the draft's §10.4: one key per
// role, derived from the ISK, and each tag over the whole transcript, so a tag is bound to both
// shares and one side's tag can't be reflected back as the other's.
//   key(role) = HMAC-SHA-512(ISK, lv_cat(PAKE_LABEL, "confirm", role))
//   tag(role) = HMAC-SHA-512(key(role), transcript_ir(Ya, ADa, Yb, ADb)), first 32 bytes
// The host sends its tag with Yb; the guest checks it before it sends its own, so the host
// proves it knows the code (and saw the same fingerprints) first. Someone without the code gets
// one guess per exchange, checked online by the other side, and nothing to test guesses against
// offline. Resume proofs (below) are gitui's own too. nearby-pake.test.ts pins every value
// these derive with known answers, so a port can't drift while both sides still agree.
//
// The package exports only what callers need (index.ts): the functions that draw their own
// scalars and nonces. The `…With` variants, which take them, are for this package's tests.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { equalBytes, fromBase64Url, randomId, toBase64Url, utf8 } from "./bytes.ts";
import {
  calculateGenerator,
  intermediateKey,
  lvCat,
  sampleScalar,
  scalarMultVfy,
  transcript,
} from "./cpace.ts";
import type { Fingerprints } from "./nearby.ts";

/** Domain separation for everything this file derives; bump it with the protocol. */
export const PAKE_LABEL = "gitui-nearby-v3";

const TAG_BYTES = 32;
const EMPTY = new Uint8Array(0);

/**
 * CI: the protocol label and both DTLS fingerprints, initiator (guest) first. The fingerprints
 * come from each side's own view of the SDPs, so a relay that swapped either makes the two
 * sides' CI differ, and with it their keys. sid stays empty: the guest's fingerprint is new for
 * every connection (browsers make a certificate per peer connection), and the scalars are new
 * for every run. sdpFingerprint is what normalizes the fingerprints.
 */
export function channelId({ guest, host }: Fingerprints): Uint8Array {
  return lvCat(PAKE_LABEL, guest, host);
}

/** The key-confirmation tag the `role` side sends (gitui's own; see the top of this file). */
function confirmTag(isk: Uint8Array, role: "guest" | "host", ya: Uint8Array, yb: Uint8Array) {
  const key = hmac(sha512, isk, lvCat(PAKE_LABEL, "confirm", role));
  return hmac(sha512, key, transcript(ya, yb)).subarray(0, TAG_BYTES);
}

/** The guest's run after sending its share: what it needs to check the host's answer. */
export interface GuestPake {
  readonly scalar: bigint;
  readonly ya: Uint8Array;
}

/** The host's run after answering: the tag it expects from the guest. */
export interface HostPake {
  readonly guestTag: Uint8Array;
}

/** Guest, step 1: a share for `code` on this connection, and the `pake` message to send. */
export function guestStart(code: string, prints: Fingerprints) {
  return guestStartWith(code, prints, sampleScalar());
}

/** guestStart with the scalar given. */
export function guestStartWith(
  code: string,
  prints: Fingerprints,
  scalar: bigint,
): { state: GuestPake; message: { t: "pake"; y: string } } {
  const g = calculateGenerator(utf8(code), channelId(prints), EMPTY);
  const ya = g.multiply(scalar).toBytes();
  return { state: { scalar, ya }, message: { t: "pake", y: toBase64Url(ya) } };
}

/**
 * Host, step 2: the answer to a guest's `pake` for `code`, with the host's tag, or null if the
 * guest's share isn't a valid one (which counts as a wrong code).
 */
export function hostRespond(code: string, prints: Fingerprints, y: string) {
  return hostRespondWith(code, prints, y, sampleScalar());
}

/** hostRespond with the scalar given. */
export function hostRespondWith(
  code: string,
  prints: Fingerprints,
  y: string,
  scalar: bigint,
): { state: HostPake; message: { t: "pake"; y: string; confirm: string } } | null {
  const ya = fromBase64Url(y, 32);
  if (!ya) return null;
  const g = calculateGenerator(utf8(code), channelId(prints), EMPTY);
  const yb = g.multiply(scalar).toBytes();
  const k = scalarMultVfy(scalar, ya);
  if (!k) return null;
  const isk = intermediateKey(k, ya, yb);
  return {
    state: { guestTag: confirmTag(isk, "guest", ya, yb) },
    message: {
      t: "pake",
      y: toBase64Url(yb),
      confirm: toBase64Url(confirmTag(isk, "host", ya, yb)),
    },
  };
}

/**
 * Guest, step 3: checks the host's answer. The `pake-confirm` to send if the host proved it
 * knows the code on this connection, else null (a wrong code, or not the host it claims to be).
 */
export function guestFinish(
  state: GuestPake,
  answer: { y: string; confirm: string },
): { t: "pake-confirm"; confirm: string } | null {
  const yb = fromBase64Url(answer.y, 32);
  const tag = fromBase64Url(answer.confirm, TAG_BYTES);
  if (!yb || !tag) return null;
  const k = scalarMultVfy(state.scalar, yb);
  if (!k) return null;
  const isk = intermediateKey(k, state.ya, yb);
  if (!equalBytes(tag, confirmTag(isk, "host", state.ya, yb))) return null;
  return { t: "pake-confirm", confirm: toBase64Url(confirmTag(isk, "guest", state.ya, yb)) };
}

/** Host, step 4: whether the guest's `pake-confirm` proves it knows the code. */
export function hostFinish(state: HostPake, confirm: string): boolean {
  const tag = fromBase64Url(confirm, TAG_BYTES);
  return tag !== null && equalBytes(tag, state.guestTag);
}

// ── Resume ─────────────────────────────────────────────────────────────────────────────────

/** Random bytes in a resume nonce. */
const NONCE_BYTES = 16;

/**
 * gitui's resume proof: HMAC-SHA-256 keyed by `token`, over who proves it, the connection
 * (channelId) and the nonce.
 */
function resumeProof(token: string, role: "guest" | "host", prints: Fingerprints, nonce: string) {
  const data = lvCat(PAKE_LABEL, "resume", role, channelId(prints), nonce);
  return toBase64Url(hmac(sha256, utf8(token), data));
}

/** Guest: the `resume` message for `token` on this connection; keep it to check the answer. */
export function resumeStart(token: string, prints: Fingerprints) {
  return resumeStartWith(token, prints, randomId(NONCE_BYTES));
}

/** resumeStart with the nonce given. */
export function resumeStartWith(
  token: string,
  prints: Fingerprints,
  nonce: string,
): { t: "resume"; nonce: string; proof: string } {
  return { t: "resume", nonce, proof: resumeProof(token, "guest", prints, nonce) };
}

/**
 * Host: the live token a guest's `resume` proves it holds, and the `resume-ok` that proves this
 * host holds it too, or null. Checks every token, in constant time each.
 */
export function resumeAnswer(
  tokens: readonly string[],
  prints: Fingerprints,
  resume: { nonce: string; proof: string },
): { token: string; message: { t: "resume-ok"; proof: string } } | null {
  const proof = utf8(resume.proof);
  let found: string | null = null;
  for (const token of tokens) {
    if (equalBytes(proof, utf8(resumeProof(token, "guest", prints, resume.nonce)))) found = token;
  }
  if (found === null) return null;
  return {
    token: found,
    message: { t: "resume-ok", proof: resumeProof(found, "host", prints, resume.nonce) },
  };
}

/** Guest: whether the host's `resume-ok` proves it holds the token the guest resumed with. */
export function resumeVerify(
  token: string,
  prints: Fingerprints,
  sent: { nonce: string },
  answer: { proof: string },
): boolean {
  return equalBytes(utf8(answer.proof), utf8(resumeProof(token, "host", prints, sent.nonce)));
}
