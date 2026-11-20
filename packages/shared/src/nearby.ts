// "Nearby": a phone on gitui.diffiii.dev finds a gitui CLI on the same network and talks to it
// over WebRTC. Shared by apps/rendezvous (the Cloudflare Worker), apps/cli (the host) and
// apps/web (the guest). Every message is read with nearby-codec.ts; authentication is in
// nearby-pake.ts.
//
// 1. Rendezvous. Hosts (CLIs) and guests (browsers) open a WebSocket to the rendezvous Worker
//    at RENDEZVOUS_PATH. The Worker routes each socket to the Durable Object of its network
//    (a hash of the public IP: the address for IPv4, the /64 for IPv6). The object tells guests
//    which hosts are online and forwards `signal` messages between a guest and a host. It keeps
//    no state beyond the live sockets. When a peer leaves, every peer of the other role on the
//    network gets its `gone`. A host says hello with a display name and a random secret
//    (HOST_SECRET); the object lists it under hostKey(secret), so only the holder of the secret
//    can be listed under that key, or take its sockets.
// 2. WebRTC. The guest creates the offer, with a fresh `offerId` that the host's answer and
//    both sides' candidates repeat, so signals of an older offer are told apart and dropped. A
//    host that won't take an offer says so with `refused`. The data channel (DATA_CHANNEL_LABEL,
//    ordered and reliable) then connects the two directly. Guests keep their rendezvous socket
//    open for the whole session: hosts end a session as soon as its guest is `gone`, which is
//    how a closed tab is noticed at once (WebRTC alone takes ~30 s, and WebKit doesn't fire
//    `close`).
// 3. Auth, on the data channel, before anything else. The host prints a 6-digit code once the
//    channel opens, and the two run CPace (nearby-pake.ts), a PAKE keyed by the code and bound
//    to both DTLS fingerprints as each side read them from the SDPs (sdpFingerprint, exactly one
//    SHA-256 per SDP), with a key confirmation of gitui's own (not the draft's):
//      guest → host  { t: "pake", y }
//      host → guest  { t: "pake", y, confirm }   the host's key-confirmation tag
//      guest → host  { t: "pake-confirm", confirm } once the host's tag checked out, or
//                    { t: "pake-fail" } if it didn't (a wrong code, or not the real host)
//      host → guest  `auth-ok` then `session` (a resume token), or `auth-fail` (`locked` when
//                    the host's pairing budget, not the channel's attempts, ran out)
//    The host proves it knows the code first, so a guest never confirms to a host that doesn't.
//    Each `pake` the host answers spends one of AUTH_ATTEMPTS attempts; after the last one fails
//    the host closes the channel. A guest that paired with this host before (same HostInfo.key)
//    may instead open with `resume`: a nonce and an HMAC proof keyed by the token. The host
//    answers `resume-ok` with its own proof of the token, and the guest refuses a host whose
//    proof doesn't check out (it doesn't fall back to the code). Its offer then says
//    `resume: true`, so the host prints no code unless the resume fails. A refused first
//    `resume` gets `auth-fail` with every attempt still left (tokens can't be guessed; the
//    attempts guard the code), and the host prints the code: the guest asks for it on the same
//    channel. Any later `resume` counts as a failed attempt.
// 4. HTTP. After auth the guest sends requests and the host answers them with the Hono app.
//    Heads are JSON text messages; bodies are binary frames (frameChunk) of at most CHUNK_SIZE
//    payload bytes; an `end` message closes each body. A guest may `cancel` a request. Both
//    sides pause sending above CHANNEL_HIGH_WATER queued bytes.
// 5. Keepalive. Hosts send WebSocket protocol pings (free, and they don't wake the object).
//    Browsers can't, so guests send RENDEZVOUS_PING as text, which the object answers with
//    RENDEZVOUS_PONG without waking up.
//
// Security. The rendezvous isn't trusted to authenticate anyone. It sees who is online, the
// SDPs and the candidates (addresses), and it could swap SDPs to sit in the middle of a
// connection; but CPace binds the code to the fingerprints each side sees, so a relay that
// swapped them derives other keys and the confirmation fails, and an observed run gives it
// nothing to test codes against offline. Names are public hints for finding a host, not
// proofs: any device on the network can list itself under a copied name (though not under a
// copied key, which takes the host's secret), and it then fails the code's confirmation and
// can't prove a resume token. What remains is online guessing (one guess per `pake`, bounded
// by the attempts per channel, the host's limits on offers and its pairing budget across every
// channel), and anyone who can read the code in the host's terminal. The Worker's Origin check
// only keeps other websites' pages from opening guest sockets in their visitors' browsers;
// anything that isn't a browser can send whatever Origin it likes.
import { sha256 } from "@noble/hashes/sha2.js";
import { randomId, toBase64Url, utf8 } from "./bytes.ts";

/** Where the rendezvous Worker lives (apps/rendezvous). */
export const RENDEZVOUS_ORIGIN = "wss://rendezvous.gitui.diffiii.dev";
export const RENDEZVOUS_PATH = "/v1/connect";
/** Text keepalive for browser guests; the object auto-responds with RENDEZVOUS_PONG. */
export const RENDEZVOUS_PING = '{"type":"ping"}';
export const RENDEZVOUS_PONG = '{"type":"pong"}';
/** Longest host display name, in code points, after trimming (hostName). */
export const MAX_NAME_LENGTH = 63;
export const DATA_CHANNEL_LABEL = "gitui";
export const STUN_URLS = ["stun:stun.cloudflare.com:3478"];
/** Payload bytes per binary frame; safe for SCTP messages in every browser. */
export const CHUNK_SIZE = 16 * 1024;
/**
 * Digits in the code. With CPace the only attack on it is guessing online, one guess per `pake`
 * the host answers, so the host's limits on attempts and offers are what bound it.
 */
export const AUTH_CODE_DIGITS = 6;
/** `pake`s (and resumes after the first) a channel may fail before the host closes it. */
export const AUTH_ATTEMPTS = 3;
/** The most guests a host lets prove themselves with a code at once; more are `busy`. */
export const MAX_PENDING = 4;
/**
 * The same for offers that say they resume, in a pool of their own, so that offers for a code
 * can't keep paired devices out.
 */
export const MAX_PENDING_RESUMES = 2;

/**
 * Data channel flow control, for both peers: a sender stops once more than CHANNEL_HIGH_WATER
 * bytes are queued, and goes on when the queue drains to CHANNEL_LOW_WATER.
 */
export const CHANNEL_HIGH_WATER = 1024 * 1024;
export const CHANNEL_LOW_WATER = 256 * 1024;

/** Longest message a peer may send the rendezvous, in UTF-16 code units. An SDP is a few KiB. */
export const MAX_MESSAGE_LENGTH = 64 * 1024;

// ── What a host sends the rendezvous ──────────────────────────────────────────────────────
// The rendezvous charges a host's key HOST_RATE_LIMIT messages per RATE_WINDOW
// (apps/rendezvous/src/network.ts); these bound what the CLI sends in one, and a test there
// checks the limit covers them.

/** The rendezvous counts messages in fixed windows of this many ms: floor(now / RATE_WINDOW). */
export const RATE_WINDOW = 10_000;
/**
 * The most offers a host takes per minute, so at most this many in any RATE_WINDOW too. Of
 * these, MAX_RESUMES_PER_MINUTE are kept for offers that resume, and the rest for the others,
 * so offers for a code can't use them all. Half: a phone that comes back to the tab often may
 * resume several times a minute, and nobody types 6 codes a minute.
 */
export const MAX_OFFERS_PER_MINUTE = 12;
export const MAX_RESUMES_PER_MINUTE = 6;
/** The most local candidates a host trickles for one offer; it drops the rest. */
export const MAX_LOCAL_CANDIDATES = 16;
/** The most `refused` signals a host sends per RATE_WINDOW; past that it ignores offers quietly. */
export const MAX_REFUSALS_PER_WINDOW = 16;

// ── Rendezvous WebSocket (JSON text messages) ─────────────────────────────────────────────

export interface HostInfo {
  /** Peer id the object assigned to the host's socket. */
  id: string;
  /** Display name, e.g. "Jan's MacBook". */
  name: string;
  /**
   * hostKey of the CLI's per-run secret, the same on all its sockets (it registers over IPv4
   * and IPv6, and reconnects). Guests use it to list a host once and to find their resume
   * token. Public, and no proof of identity: only a socket with the same secret is listed under
   * it, but only CPace and the resume proofs (step 3) authenticate the host behind it.
   */
  key: string;
}

/** HostInfo.key: 16 to 64 URL-safe characters (hostKey makes 22). */
export const HOST_KEY = /^[\w-]{16,64}$/;

/** A host's hello secret: at least 32 random bytes, base64url (43 to 128 characters). */
export const HOST_SECRET = /^[\w-]{43,128}$/;

/** The label hostKey hashes before the secret, so the hash is of use for nothing else. */
const HOST_KEY_LABEL = "gitui-nearby-host-key";

/**
 * A host's public key, HostInfo.key: the first 16 bytes of
 * SHA-256(HOST_KEY_LABEL ‖ secret), base64url. The label is fixed, so the split is unambiguous.
 */
export function hostKey(secret: string): string {
  return toBase64Url(sha256(utf8(HOST_KEY_LABEL + secret)).subarray(0, 16));
}

/** A peer id the rendezvous assigned (a UUID from the Worker). */
export const PEER_ID = /^[\w-]{1,64}$/;

/** SignalData.offerId: 16 to 64 URL-safe characters, random (newOfferId). */
export const OFFER_ID = /^[\w-]{16,64}$/;

/** A fresh SignalData offerId. */
export const newOfferId = () => randomId(16);

/** An ICE candidate as browsers' RTCIceCandidateInit carries it. */
export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  /** 0 to 65535. */
  sdpMLineIndex?: number | null;
}

/**
 * A WebRTC signal, relayed by the rendezvous object. Every signal names the guest's offer it
 * belongs to: the host's answer and both sides' candidates repeat its `offerId`, and each side
 * drops signals of an offer that isn't its current one. `Reason` is what a `refused` carries,
 * which differs by who holds the signal: SignalData, SentSignal and RelayedSignal.
 */
type Signal<Reason extends string> =
  /** `resume`: the guest will open with `resume`, so the host needn't print a code (step 3). */
  | { kind: "offer"; offerId: string; sdp: string; resume?: true }
  | { kind: "answer"; offerId: string; sdp: string }
  | { kind: "candidate"; offerId: string; candidate: IceCandidate }
  /** Host to guest: it won't answer this offer, and why. */
  | { kind: "refused"; offerId: string; reason: Reason };

/** A signal as a peer decodes it (decodeSignal): a reason it doesn't know is `unknown`. */
export type SignalData = Signal<RefusalReason>;
/** A signal as a peer sends it: only reasons it knows. */
export type SentSignal = Signal<WireRefusalReason>;
/**
 * A signal as the rendezvous relays it: any REASON_SLUG, passed on unchanged, since it never
 * acts on one, so a newer host's reasons reach newer guests.
 */
export type RelayedSignal = Signal<string>;

/**
 * Why a host refused an offer (SignalData's `refused`), as hosts send it.
 * - `busy`: too many guests are proving themselves at once (MAX_PENDING, or for offers that
 *   resume, MAX_PENDING_RESUMES).
 * - `rate-limited`: too many offers came lately (MAX_OFFERS_PER_MINUTE).
 * - `pairing-locked`: too many codes were tried on the host lately, so it pairs no new device
 *   for a while; paired devices can still resume.
 * - `bad-offer`: the host can't use the offer (e.g. its SDP hasn't exactly one SHA-256
 *   fingerprint).
 *
 * New reasons decode as `unknown` where they aren't known yet (older guests), so adding one
 * breaks nothing.
 */
export type WireRefusalReason = "busy" | "rate-limited" | "pairing-locked" | "bad-offer";
/** A refusal's reason as a guest decodes it: `unknown` for one this version doesn't know. */
export type RefusalReason = WireRefusalReason | "unknown";
export const REFUSAL_REASONS: readonly WireRefusalReason[] = [
  "busy",
  "rate-limited",
  "pairing-locked",
  "bad-offer",
];
export const isRefusalReason = (value: unknown): value is WireRefusalReason =>
  (REFUSAL_REASONS as readonly unknown[]).includes(value);
/** What the rendezvous relays as a refusal's reason (RelayedSignal). */
export const REASON_SLUG = /^[a-z-]{1,32}$/;

/** Messages a peer sends to the rendezvous object. */
export type ClientMessage =
  /** `secret` matches HOST_SECRET; the object lists the host under hostKey(secret). */
  | { type: "hello"; role: "host"; name: string; secret: string }
  | { type: "hello"; role: "guest" }
  | { type: "signal"; to: string; data: RelayedSignal };

/**
 * Messages the rendezvous object sends to a peer: as a peer decodes them by default, and as the
 * object sends them with SentServerMessage.
 */
export type ServerMessage<Data = SignalData, Code = ErrorCode> =
  /** Reply to `hello`: this socket's peer id. */
  | { type: "welcome"; id: string }
  /** To guests, after `hello` and whenever the set of hosts changes. */
  | { type: "hosts"; hosts: HostInfo[] }
  | { type: "signal"; from: string; data: Data }
  /** The peer `id` disconnected; every peer of the other role on the network gets this. */
  | { type: "gone"; id: string }
  /** What went wrong; the socket is closed after it unless `code` is `unknown-peer`. */
  | { type: "error"; code: Code; message: string }
  /** Auto-response to RENDEZVOUS_PING. */
  | { type: "pong" };

/** What the rendezvous sends: signals as it relays them, and only codes it knows. */
export type SentServerMessage = ServerMessage<RelayedSignal, WireErrorCode>;

/**
 * Why the rendezvous sent an `error`, as it sends it. Every one but `unknown-peer` closes the
 * socket.
 * - `hello-required`: a signal before `hello`, or no `hello` within the Worker's timeout.
 * - `invalid-message`: binary, not the contract's, or a second `hello`.
 * - `too-large`: over MAX_MESSAGE_LENGTH.
 * - `origin-required`: a guest's `hello` from a socket without an allowed Origin.
 * - `rate-limit`: this socket (or, for a host, its key) sent too much in its RATE_WINDOW.
 * - `host-limit`: the network lists as many host keys as it may.
 * - `key-limit`: this host's key already has as many sockets as it may.
 * - `unknown-peer`: a signal to a peer that isn't here (or has the same role).
 *
 * New codes decode as `unknown` where they aren't known yet, so adding one breaks nothing.
 */
export type WireErrorCode =
  | "hello-required"
  | "invalid-message"
  | "too-large"
  | "origin-required"
  | "rate-limit"
  | "host-limit"
  | "key-limit"
  | "unknown-peer";
/** An `error`'s code as a peer decodes it: `unknown` for one this version doesn't know. */
export type ErrorCode = WireErrorCode | "unknown";
export const ERROR_CODES: readonly WireErrorCode[] = [
  "hello-required",
  "invalid-message",
  "too-large",
  "origin-required",
  "rate-limit",
  "host-limit",
  "key-limit",
  "unknown-peer",
];
export const isErrorCode = (value: unknown): value is WireErrorCode =>
  (ERROR_CODES as readonly unknown[]).includes(value);

// ── Data channel ──────────────────────────────────────────────────────────────────────────

/**
 * A DTLS fingerprint as sdpFingerprint reads it: "sha-256 ab:cd:…", lowercase. Branded so
 * that sdpFingerprint is the only place that makes (and normalizes) one.
 */
export type Fingerprint = string & { readonly __brand: "Fingerprint" };

/** Both DTLS fingerprints of a connection, by role, as each side read them from the SDPs. */
export interface Fingerprints {
  guest: Fingerprint;
  host: Fingerprint;
}

/** JSON text messages the guest sends on the data channel (step 3, then 4). */
export type GuestMessage =
  /** CPace share Ya for the code (nearby-pake.ts guestStart). */
  | { t: "pake"; y: string }
  /** The guest's key-confirmation tag, sent only after the host's checked out. */
  | { t: "pake-confirm"; confirm: string }
  /** The host's tag didn't check out: a wrong code, or not the host it claims to be. */
  | { t: "pake-fail" }
  /** Instead of a code: a proof of the token from an earlier `session` (resumeStart). */
  | { t: "resume"; nonce: string; proof: string }
  | { t: "req"; id: number; method: string; path: string; headers: [string, string][] }
  /** Ends the body of request `id`. */
  | { t: "end"; id: number }
  /** The guest no longer wants request `id`; the host stops sending its response. */
  | { t: "cancel"; id: number };

/** JSON text messages the host sends on the data channel. */
export type HostMessage =
  /** CPace share Yb and the host's key-confirmation tag (hostRespond). */
  | { t: "pake"; y: string; confirm: string }
  /** The resume token checked out; `proof` is the host's own proof of it (resumeAnswer). */
  | { t: "resume-ok"; proof: string }
  /** The guest's `pake-confirm` checked out. */
  | { t: "auth-ok" }
  /** Sent after `auth-ok`: a token the guest may use to `resume` while this CLI runs. */
  | { t: "session"; token: string }
  /**
   * `locked`: the host's pairing budget ran out (not this channel's attempts), so it takes no
   * code for a while; sent with `attemptsLeft: 0`. Guests that don't know it see a last failure.
   */
  | { t: "auth-fail"; attemptsLeft: number; locked?: true }
  | { t: "res"; id: number; status: number; headers: [string, string][] }
  /** Ends the body of response `id`. */
  | { t: "end"; id: number }
  /** The host couldn't answer request `id` (e.g. the app threw). */
  | { t: "abort"; id: number; message: string };

/** JSON text messages on the data channel. Binary messages are body frames (frameChunk). */
export type ChannelMessage = GuestMessage | HostMessage;

/** A binary frame: a 4-byte big-endian request id, then up to CHUNK_SIZE payload bytes. */
export function frameChunk(id: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > CHUNK_SIZE) throw new RangeError("chunk larger than CHUNK_SIZE");
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(payload, 4);
  return frame;
}

export function parseChunk(frame: Uint8Array): { id: number; payload: Uint8Array } {
  if (frame.byteLength < 4) throw new RangeError("frame shorter than its header");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { id: view.getUint32(0), payload: frame.subarray(4) };
}

/** Splits a body into CHUNK_SIZE pieces. */
export function* chunks(body: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < body.byteLength; at += CHUNK_SIZE) {
    yield body.subarray(at, at + CHUNK_SIZE);
  }
}
