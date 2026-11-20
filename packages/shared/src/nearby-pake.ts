// Authentication on the nearby data channel (nearby.ts, step 3): CPace for the code, and HMAC
// proofs both ways for resume tokens. Pure and synchronous: every function takes its state and
// returns the next one, so the CLI (host) and the web app (guest) run the same code, and tests
// run it without a channel.
//
// CPace (draft-irtf-cfrg-cpace-21) on ristretto255 with SHA-512, initiator-responder mode: the
// guest is A (initiator), the host is B (responder).
//   PRS = the code, UTF-8.   sid = b"" (see channelId).   ADa = ADb = b"".
//   CI  = lv_cat(PAKE_LABEL, guest fingerprint, host fingerprint) (channelId).
//   ISK = SHA-512(lv_cat("CPaceRistretto255_ISK", sid, K) || lv_cat(Ya, ADa) || lv_cat(Yb, ADb))
// Key confirmation (the draft's §10.4, with a key per direction):
//   key(role) = HMAC-SHA-512(ISK, lv_cat(PAKE_LABEL, "confirm", role))
//   tag(role) = HMAC-SHA-512(key(role), transcript_ir(Ya, ADa, Yb, ADb)), first 32 bytes
// The host sends its tag with Yb; the guest checks it before it sends its own, so the host
// proves it knows the code (and saw the same fingerprints) first. Someone without the code gets
// one guess per exchange, checked online by the other side, and nothing to test guesses against
// offline.
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/** Domain separation for everything this file derives; bump it with the protocol. */
export const PAKE_LABEL = "gitui-nearby-v2";

/** Both DTLS fingerprints of a connection (sdpFingerprint), by role, as each side sees them. */
export interface Fingerprints {
  guest: string;
  host: string;
}

const Point = ristretto255.Point;
type Point = InstanceType<typeof Point>;

const DSI = utf8("CPaceRistretto255");
const DSI_ISK = utf8("CPaceRistretto255_ISK");
/** SHA-512's input block size. */
const S_IN_BYTES = 128;
const TAG_BYTES = 32;

// ── Byte strings ───────────────────────────────────────────────────────────────────────────

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The draft's prepend_len: the LEB128 length, then the bytes. */
export function prependLen(data: Uint8Array): Uint8Array {
  const length: number[] = [];
  let n = data.byteLength;
  do {
    length.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  } while (n > 0);
  return concat(Uint8Array.from(length), data);
}

/** The draft's lv_cat: each part with its length prepended. */
export function lvCat(...parts: (Uint8Array | string)[]): Uint8Array {
  return concat(...parts.map((p) => prependLen(typeof p === "string" ? utf8(p) : p)));
}

/** Equality in time that depends only on the lengths. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The bytes of unpadded base64url `text` that encodes exactly `length` bytes, or null. */
export function fromBase64Url(text: string, length: number): Uint8Array | null {
  if (text.length !== Math.ceil((length * 4) / 3) || !/^[\w-]*$/.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Rejects encodings with stray low bits, so each value has one encoding.
  return bytes.byteLength === length && toBase64Url(bytes) === text ? bytes : null;
}

/** A base64url string of `bytes` random bytes. */
export const randomId = (bytes: number) => toBase64Url(randomBytes(bytes));

// ── CPace ──────────────────────────────────────────────────────────────────────────────────

/** CI: the protocol label and both DTLS fingerprints, initiator (guest) first. */
export function channelId({ guest, host }: Fingerprints): Uint8Array {
  // The fingerprints come from each side's own view of the SDPs, so a relay that swapped either
  // makes the two sides' CI differ, and with it their keys. sid stays empty: the guest's
  // fingerprint is new for every connection (browsers make a certificate per peer connection),
  // and the scalars are new for every run.
  return lvCat(PAKE_LABEL, guest.toLowerCase(), host.toLowerCase());
}

/** The draft's generator_string. */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(
    0,
    S_IN_BYTES - 1 - prependLen(prs).byteLength - prependLen(DSI).byteLength,
  );
  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** The draft's calculate_generator for ristretto255. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Point {
  return ristretto255_hasher.deriveToCurve!(sha512(generatorString(prs, ci, sid)));
}

/** The draft's recommended sample_scalar: 32 random bytes, top 4 bits cleared, little-endian. */
export function sampleScalar(): bigint {
  for (;;) {
    const bytes = randomBytes(32);
    bytes[31]! &= 0x0f;
    const scalar = scalarFromBytes(bytes);
    if (scalar !== 0n) return scalar;
  }
}

function scalarFromBytes(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.byteLength - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** The draft's scalar_mult_vfy: null for an invalid encoding or the identity. */
export function scalarMultVfy(scalar: bigint, encoded: Uint8Array): Uint8Array | null {
  let point: Point;
  try {
    point = Point.fromBytes(encoded);
  } catch {
    return null;
  }
  const k = point.multiply(scalar);
  return k.is0() ? null : k.toBytes();
}

const EMPTY = new Uint8Array(0);

/** The draft's ISK; gitui's runs leave sid, ADa and ADb empty. */
export function intermediateKey(
  k: Uint8Array,
  ya: Uint8Array,
  yb: Uint8Array,
  { sid = EMPTY, ada = EMPTY, adb = EMPTY } = {},
): Uint8Array {
  return sha512(concat(lvCat(DSI_ISK, sid, k), transcript(ya, yb, ada, adb)));
}

/** The draft's transcript_ir(Ya, ADa, Yb, ADb). */
function transcript(ya: Uint8Array, yb: Uint8Array, ada = EMPTY, adb = EMPTY): Uint8Array {
  return concat(lvCat(ya, ada), lvCat(yb, adb));
}

/** The key-confirmation tag the `role` side sends. */
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
export function guestStart(
  code: string,
  prints: Fingerprints,
  scalar: bigint = sampleScalar(),
): { state: GuestPake; message: { t: "pake"; y: string } } {
  const g = calculateGenerator(utf8(code), channelId(prints), EMPTY);
  const ya = g.multiply(scalar).toBytes();
  return { state: { scalar, ya }, message: { t: "pake", y: toBase64Url(ya) } };
}

/**
 * Host, step 2: the answer to a guest's `pake` for `code`, with the host's tag, or null if the
 * guest's share isn't a valid one (which counts as a wrong code).
 */
export function hostRespond(
  code: string,
  prints: Fingerprints,
  y: string,
  scalar: bigint = sampleScalar(),
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

/** HMAC-SHA-256 keyed by `token`, over who proves it, the connection and the nonce. */
function resumeProof(token: string, role: "guest" | "host", prints: Fingerprints, nonce: string) {
  const data = lvCat(PAKE_LABEL, "resume", role, ...channelParts(prints), nonce);
  return toBase64Url(hmac(sha256, utf8(token), data));
}

const channelParts = ({ guest, host }: Fingerprints) => [guest.toLowerCase(), host.toLowerCase()];

/** Guest: the `resume` message for `token` on this connection; keep it to check the answer. */
export function resumeStart(
  token: string,
  prints: Fingerprints,
  nonce: string = randomId(NONCE_BYTES),
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
