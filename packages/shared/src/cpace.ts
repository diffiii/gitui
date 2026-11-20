// The primitives of CPace (draft-irtf-cfrg-cpace-21) on ristretto255 with SHA-512, as the draft
// defines them and tested against its vectors (cpace.test.ts). Internal to @gitui/shared:
// nearby-pake.ts builds gitui's protocol on them, and index.ts doesn't export them.
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "./bytes.ts";

const Point = ristretto255.Point;
export type Point = InstanceType<typeof Point>;

const DSI = utf8("CPaceRistretto255");
const DSI_ISK = utf8("CPaceRistretto255_ISK");
/** SHA-512's input block size. */
const S_IN_BYTES = 128;
const EMPTY = new Uint8Array(0);

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

/** The draft's lv_cat: each part with its length prepended. Strings count as UTF-8. */
export function lvCat(...parts: (Uint8Array | string)[]): Uint8Array {
  return concat(...parts.map((p) => prependLen(typeof p === "string" ? utf8(p) : p)));
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
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    bytes[31]! &= 0x0f;
    const scalar = scalarFromBytes(bytes);
    if (scalar !== 0n) return scalar;
  }
}

/** A little-endian scalar. */
export function scalarFromBytes(bytes: Uint8Array): bigint {
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

/** The draft's transcript_ir(Ya, ADa, Yb, ADb). */
export function transcript(ya: Uint8Array, yb: Uint8Array, ada = EMPTY, adb = EMPTY): Uint8Array {
  return concat(lvCat(ya, ada), lvCat(yb, adb));
}

/** The draft's ISK, initiator-responder mode. */
export function intermediateKey(
  k: Uint8Array,
  ya: Uint8Array,
  yb: Uint8Array,
  { sid = EMPTY, ada = EMPTY, adb = EMPTY } = {},
): Uint8Array {
  return sha512(concat(lvCat(DSI_ISK, sid, k), transcript(ya, yb, ada, adb)));
}
