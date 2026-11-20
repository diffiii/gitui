// Byte-string helpers for the nearby modules. Internal to @gitui/shared: index.ts doesn't export
// them.

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
export const randomId = (bytes: number) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Equality in time that depends only on the lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
