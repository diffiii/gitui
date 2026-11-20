// Every check on what crosses the nearby protocol's wires (nearby.ts), in one place: the
// rendezvous Worker, the CLI (host) and the web app (guest) all read messages with these. Each
// decoder rebuilds its value from the contract's fields only, so nothing else is relayed or
// trusted, and throws a NearbyCodecError that says what is wrong; the parse* wrappers return
// null instead. Pure, with nothing beyond what browsers, Node and Workers all have; it imports
// no curve code, so the Worker's bundle doesn't either.
import { fromBase64Url } from "./bytes.ts";
import {
  AUTH_ATTEMPTS,
  type ChannelMessage,
  type ClientMessage,
  type Fingerprint,
  type GuestMessage,
  HOST_KEY,
  type HostInfo,
  type HostMessage,
  type IceCandidate,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  OFFER_ID,
  parseChunk,
  PEER_ID,
  REFUSAL_REASONS,
  type RefusalReason,
  RENDEZVOUS_PATH,
  type ServerMessage,
  type SignalData,
} from "./nearby.ts";

/** A message that breaks the contract; `message` says how. */
export class NearbyCodecError extends Error {
  override name = "NearbyCodecError";
}

const fail = (message: string): never => {
  throw new NearbyCodecError(message);
};

/** `decode` as a function that returns null instead of throwing a NearbyCodecError. */
function orNull<A extends unknown[], T>(decode: (...args: A) => T): (...args: A) => T | null {
  return (...args) => {
    try {
      return decode(...args);
    } catch (e) {
      if (e instanceof NearbyCodecError) return null;
      throw e;
    }
  };
}

// ── Values ─────────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(`${what} isn't an object`);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
}

function string(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== "string") return fail(`${what} isn't a string`);
  return !pattern || pattern.test(value) ? value : fail(`invalid ${what}`);
}

/** A request id: an unsigned 32-bit integer, as body frames carry it. */
export const isId = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;

/** HTTP headers as name/value pairs. */
export const isHeaders = (value: unknown): value is [string, string][] =>
  Array.isArray(value) &&
  value.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "string" &&
      typeof pair[1] === "string",
  );

// Control characters, line and paragraph separators, and the bidi controls that could make a
// name display as another.
const UNSAFE_NAME_CHAR = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const UNSAFE_NAME_CHARS = new RegExp(UNSAFE_NAME_CHAR.source, "gu");

/**
 * A host's display name, trimmed, if it is 1 to MAX_NAME_LENGTH code points long and has no
 * control or bidi characters; else null. The Worker, `--name` and saved hosts all use this.
 */
export function hostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = Array.from(name).length; // code points
  return length >= 1 && length <= MAX_NAME_LENGTH && !UNSAFE_NAME_CHAR.test(name) ? name : null;
}

/**
 * `text` made into a valid hostName if it can be: the unsafe characters dropped and the rest cut
 * to MAX_NAME_LENGTH code points. Null if nothing is left.
 */
export function toHostName(text: string): string | null {
  const kept = Array.from(text.replace(UNSAFE_NAME_CHARS, "").trim()).slice(0, MAX_NAME_LENGTH);
  return hostName(kept.join(""));
}

/**
 * The rendezvous WebSocket URL for `origin`, a ws: or wss: origin (no path, no trailing slash),
 * or null if it isn't one. The CLI (GITUI_RENDEZVOUS_URL), the web app and its CSP
 * (VITE_GITUI_RENDEZVOUS_URL) all check the origin with this.
 */
export function rendezvousUrl(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const valid = (url.protocol === "ws:" || url.protocol === "wss:") && origin === url.origin;
  return valid ? url.origin + RENDEZVOUS_PATH : null;
}

// ── Rendezvous messages ────────────────────────────────────────────────────────────────────

function decodeCandidate(value: unknown): IceCandidate {
  const { candidate, sdpMid, sdpMLineIndex } = record(value, "candidate");
  if (typeof candidate !== "string") return fail("candidate line isn't a string");
  if (sdpMid != null && typeof sdpMid !== "string") return fail("invalid sdpMid");
  const indexOk =
    sdpMLineIndex == null ||
    (Number.isInteger(sdpMLineIndex) &&
      (sdpMLineIndex as number) >= 0 &&
      (sdpMLineIndex as number) <= 0xffff);
  if (!indexOk) return fail("invalid sdpMLineIndex");
  return {
    candidate,
    sdpMid: sdpMid as string | null | undefined,
    sdpMLineIndex: sdpMLineIndex as number | null | undefined,
  };
}

/** A WebRTC signal (SignalData). */
export function decodeSignal(value: unknown): SignalData {
  const data = record(value, "signal");
  const offerId = string(data.offerId, "offerId", OFFER_ID);
  switch (data.kind) {
    case "offer":
    case "answer": {
      const sdp = string(data.sdp, "sdp");
      if (sdp.length > MAX_MESSAGE_LENGTH) return fail("sdp too long");
      // `resume` is kept only when true; anything else means no.
      if (data.kind === "answer") return { kind: "answer", offerId, sdp };
      return data.resume === true
        ? { kind: "offer", offerId, sdp, resume: true }
        : { kind: "offer", offerId, sdp };
    }
    case "candidate":
      return { kind: "candidate", offerId, candidate: decodeCandidate(data.candidate) };
    case "refused":
      if (!REFUSAL_REASONS.includes(data.reason as RefusalReason)) return fail("invalid reason");
      return { kind: "refused", offerId, reason: data.reason as RefusalReason };
    default:
      return fail("unknown signal kind");
  }
}

/** A message a peer sends the rendezvous (ClientMessage). RENDEZVOUS_PING isn't one. */
export function decodeClientMessage(text: string): ClientMessage {
  if (text.length > MAX_MESSAGE_LENGTH) return fail("message too long");
  const message = record(json(text), "message");
  if (message.type === "hello") {
    if (message.role === "guest") return { type: "hello", role: "guest" };
    if (message.role !== "host") return fail("invalid role");
    const name = hostName(message.name) ?? fail("invalid name");
    const key = string(message.key, "key", HOST_KEY);
    return { type: "hello", role: "host", name, key };
  }
  if (message.type === "signal") {
    const to = string(message.to, "peer id", PEER_ID);
    return { type: "signal", to, data: decodeSignal(message.data) };
  }
  return fail("unknown message type");
}

function decodeHost(value: unknown): HostInfo {
  const host = record(value, "host");
  const id = string(host.id, "peer id", PEER_ID);
  const name = hostName(host.name) ?? fail("invalid name");
  return { id, name, key: string(host.key, "key", HOST_KEY) };
}

/** A message from the rendezvous (ServerMessage). Hosts that break the contract are left out. */
export function decodeServerMessage(text: string): ServerMessage {
  const message = record(json(text), "message");
  switch (message.type) {
    case "welcome":
    case "gone":
      return { type: message.type, id: string(message.id, "peer id", PEER_ID) };
    case "hosts":
      if (!Array.isArray(message.hosts)) return fail("hosts isn't an array");
      return { type: "hosts", hosts: message.hosts.flatMap((h) => parseHost(h) ?? []) };
    case "signal":
      return {
        type: "signal",
        from: string(message.from, "peer id", PEER_ID),
        data: decodeSignal(message.data),
      };
    case "error":
      return { type: "error", message: string(message.message, "error message").slice(0, 500) };
    case "pong":
      return { type: "pong" };
    default:
      return fail("unknown message type");
  }
}

const parseHost = orNull(decodeHost);
export const parseSignal = orNull(decodeSignal);
export const parseClientMessage = orNull(decodeClientMessage);
export const parseServerMessage = orNull(decodeServerMessage);

// ── Data channel ───────────────────────────────────────────────────────────────────────────

/** A data channel message, decoded; `invalid` for anything the contract doesn't allow. */
export type Incoming<M extends ChannelMessage = ChannelMessage> =
  | { kind: "message"; message: M }
  | { kind: "chunk"; id: number; payload: Uint8Array }
  /** `id` is the request the message names, if it names one. */
  | { kind: "invalid"; id: number | null; reason: string };

/** `what`: 32 bytes in canonical base64url (CPace shares, tags, resume proofs and tokens). */
function bytes32(value: unknown, what: string): string {
  const text = string(value, what);
  return fromBase64Url(text, 32) ? text : fail(`invalid ${what}`);
}
/** A resume nonce: 16 to 48 bytes, base64url. */
const NONCE = /^[\w-]{22,64}$/;
/** An HTTP method (RFC 9110 token). */
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER_ORIGIN = "http://gitui.invalid";

/** A path a request may name: absolute, and naming no other host (`//host/…`, `/\host/…`). */
function isPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    return new URL(value, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
}

function requestId(value: unknown): number {
  return isId(value) ? value : fail("no request id");
}

function decodeGuestMessage(m: Record<string, unknown>): GuestMessage {
  switch (m.t) {
    case "pake":
      return { t: "pake", y: bytes32(m.y, "share") };
    case "pake-confirm":
      return { t: "pake-confirm", confirm: bytes32(m.confirm, "tag") };
    case "pake-fail":
      return { t: "pake-fail" };
    case "resume":
      return {
        t: "resume",
        nonce: string(m.nonce, "nonce", NONCE),
        proof: bytes32(m.proof, "proof"),
      };
    case "req": {
      const id = requestId(m.id);
      if (typeof m.method !== "string" || !METHOD.test(m.method)) return fail("invalid method");
      if (!isPath(m.path)) return fail("invalid path");
      if (!isHeaders(m.headers)) return fail("invalid headers");
      return { t: "req", id, method: m.method, path: m.path, headers: m.headers };
    }
    case "end":
    case "cancel":
      return { t: m.t, id: requestId(m.id) };
    default:
      return fail(`unexpected message ${JSON.stringify(m.t)}`);
  }
}

function decodeHostMessage(m: Record<string, unknown>): HostMessage {
  switch (m.t) {
    case "pake":
      return {
        t: "pake",
        y: bytes32(m.y, "share"),
        confirm: bytes32(m.confirm, "tag"),
      };
    case "resume-ok":
      return { t: "resume-ok", proof: bytes32(m.proof, "proof") };
    case "auth-ok":
      return { t: "auth-ok" };
    case "auth-fail": {
      const left = m.attemptsLeft;
      const ok =
        Number.isInteger(left) && (left as number) >= 0 && (left as number) <= AUTH_ATTEMPTS;
      return ok ? { t: "auth-fail", attemptsLeft: left as number } : fail("invalid attemptsLeft");
    }
    case "session":
      return { t: "session", token: bytes32(m.token, "token") };
    case "res": {
      const id = requestId(m.id);
      const { status } = m;
      if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
        return fail("invalid status");
      }
      if (!isHeaders(m.headers)) return fail("invalid headers");
      return { t: "res", id, status: status as number, headers: m.headers };
    }
    case "end":
      return { t: "end", id: requestId(m.id) };
    case "abort":
      return { t: "abort", id: requestId(m.id), message: string(m.message, "abort message") };
    default:
      return fail(`unexpected message ${JSON.stringify(m.t)}`);
  }
}

/**
 * Reads one data channel message sent by `from`: JSON text is a message of that side's, binary
 * is a body frame (frameChunk).
 */
export function decodeChannelMessage(
  data: string | ArrayBuffer | Uint8Array,
  from: "guest",
): Incoming<GuestMessage>;
export function decodeChannelMessage(
  data: string | ArrayBuffer | Uint8Array,
  from: "host",
): Incoming<HostMessage>;
export function decodeChannelMessage(
  data: string | ArrayBuffer | Uint8Array,
  from: "guest" | "host",
): Incoming {
  if (typeof data !== "string") {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength < 4) return { kind: "invalid", id: null, reason: "short frame" };
    return { kind: "chunk", ...parseChunk(bytes) };
  }
  let m: Record<string, unknown>;
  try {
    m = record(json(data), "message");
  } catch (e) {
    return { kind: "invalid", id: null, reason: (e as Error).message };
  }
  try {
    const message = from === "guest" ? decodeGuestMessage(m) : decodeHostMessage(m);
    return { kind: "message", message };
  } catch (e) {
    if (!(e instanceof NearbyCodecError)) throw e;
    return { kind: "invalid", id: isId(m.id) ? m.id : null, reason: e.message };
  }
}

// ── SDP ────────────────────────────────────────────────────────────────────────────────────

const FINGERPRINT = /^a=fingerprint:sha-256 ((?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i;

/**
 * The DTLS fingerprint of an SDP, as "sha-256 ab:cd:…" (lowercase), or null unless it has
 * exactly one fingerprint line and that one is a well-formed SHA-256. WebRTC stacks accept a
 * certificate that matches any listed fingerprint (werift does), so with two lines the one read
 * here could be the one not used. Lines are split on every kind of line break, and any line
 * that mentions "fingerprint" counts, so no SDP parser finds one that this misses.
 */
export function sdpFingerprint(sdp: string): Fingerprint | null {
  const lines = sdp.split(/\r\n|\r|\n/).filter((line) => /fingerprint/i.test(line));
  if (lines.length !== 1) return null;
  const match = FINGERPRINT.exec(lines[0]!.trim());
  return match ? `sha-256 ${match[1]!.toLowerCase()}` : null;
}
