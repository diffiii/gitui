// "Nearby": a phone on gitui.diffiii.dev finds a gitui CLI on the same network and talks to it
// over WebRTC. Shared by apps/rendezvous (the Cloudflare Worker), apps/cli (the host) and
// apps/web (the guest).
//
// 1. Rendezvous. Hosts (CLIs) and guests (browsers) open a WebSocket to the rendezvous Worker
//    at RENDEZVOUS_PATH. The Worker routes each socket to the Durable Object of its network
//    (a hash of the public IP: the address for IPv4, the /64 for IPv6). The object tells guests
//    which hosts are online and forwards `signal` messages between peers. It keeps no state
//    beyond the live sockets.
// 2. WebRTC. The guest creates the offer; signals go through the object; the data channel
//    (DATA_CHANNEL_LABEL, ordered and reliable) then connects the two directly.
//    Guests keep their rendezvous socket open for the whole session: hosts end a session as soon
//    as its guest is `gone`, which is how a closed tab is noticed at once (WebRTC alone takes
//    ~30 s, and WebKit doesn't fire `close`).
// 3. Auth. The host prints a short code once the channel opens. The guest's first channel
//    message is an `auth` with a proof derived from the code and both DTLS fingerprints
//    (authProof). The host answers `auth-ok` (then `session`, a resume token) or `auth-fail`,
//    and closes after AUTH_ATTEMPTS failures. A guest that already paired with this host (same
//    HostInfo.key) may instead open with `resume`, a proof derived from the token, e.g. after
//    iOS dropped the connection. Its offer then says `resume: true`, so the host prints no code
//    unless the resume fails. A refused first `resume` gets `auth-fail` with every attempt still
//    left (tokens can't be guessed; the attempts guard the code), and the host prints the code:
//    the guest asks for it on the same channel. Any later `resume` counts as a failed attempt.
//    Only the code and resume proofs authenticate: HostInfo.key is public.
// 4. HTTP. After auth the guest sends requests and the host answers them with the Hono app.
//    Heads are JSON text messages; bodies are binary frames (frameChunk) of at most CHUNK_SIZE
//    payload bytes; an `end` message closes each body. A guest may `cancel` a request.
// 5. Keepalive. Hosts send WebSocket protocol pings (free, and they don't wake the object).
//    Browsers can't, so guests send RENDEZVOUS_PING as text, which the object answers with
//    RENDEZVOUS_PONG without waking up.

/** Where the rendezvous Worker lives (apps/rendezvous). */
export const RENDEZVOUS_ORIGIN = "wss://rendezvous.gitui.diffiii.dev";
export const RENDEZVOUS_PATH = "/v1/connect";
/** Text keepalive for browser guests; the object auto-responds with RENDEZVOUS_PONG. */
export const RENDEZVOUS_PING = '{"type":"ping"}';
export const RENDEZVOUS_PONG = '{"type":"pong"}';
/** Longest host display name, after trimming. */
export const MAX_NAME_LENGTH = 63;
export const DATA_CHANNEL_LABEL = "gitui";
export const STUN_URLS = ["stun:stun.cloudflare.com:3478"];
/** Payload bytes per binary frame; safe for SCTP messages in every browser. */
export const CHUNK_SIZE = 16 * 1024;
export const AUTH_CODE_DIGITS = 6;
export const AUTH_ATTEMPTS = 3;

// ── Rendezvous WebSocket (JSON text messages) ─────────────────────────────────────────────

export interface HostInfo {
  /** Peer id the object assigned to the host's socket. */
  id: string;
  /** Display name, e.g. "Jan's MacBook". */
  name: string;
  /**
   * Random per-run id of the CLI, the same on all its sockets (it registers over IPv4 and IPv6,
   * and reconnects). Guests use it to list a host once and to find their resume token.
   * Not a secret and no proof of identity: every guest on the network sees it, and any device
   * there can register as a host with the same key and name. What authenticates is the code and
   * resume proofs (step 3), which are bound to the connection's DTLS fingerprints. They
   * authenticate the guest to the host only: a device posing as a host can answer `auth-ok` to
   * anything, and would then see the guest's requests. It learns no usable token (a proof is
   * bound to its own fingerprint), but it can brute-force a code from its proof, the same
   * limitation as authProof's; a PAKE with key confirmation would close both.
   */
  key: string;
}

/** HostInfo.key: 16 to 64 URL-safe characters. */
export const HOST_KEY = /^[\w-]{16,64}$/;

/** WebRTC signaling payload, relayed verbatim by the rendezvous object. */
export type SignalData =
  /** `resume`: the guest will open with `resume`, so the host needn't print a code (step 3). */
  | { kind: "offer"; sdp: string; resume?: boolean }
  | { kind: "answer"; sdp: string }
  | {
      kind: "candidate";
      candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
    };

/** Messages a peer sends to the rendezvous object. */
export type ClientMessage =
  | { type: "hello"; role: "host"; name: string; key: string }
  | { type: "hello"; role: "guest" }
  | { type: "signal"; to: string; data: SignalData };

/** Messages the rendezvous object sends to a peer. */
export type ServerMessage =
  /** Reply to `hello`: this socket's peer id. */
  | { type: "welcome"; id: string }
  /** To guests, after `hello` and whenever the set of hosts changes. */
  | { type: "hosts"; hosts: HostInfo[] }
  | { type: "signal"; from: string; data: SignalData }
  /** The peer `id` disconnected (sent to peers it was signaling with, and to guests). */
  | { type: "gone"; id: string }
  | { type: "error"; message: string }
  /** Auto-response to RENDEZVOUS_PING. */
  | { type: "pong" };

// ── Data channel ──────────────────────────────────────────────────────────────────────────

/** JSON text messages on the data channel. Binary messages are body frames (frameChunk). */
export type ChannelMessage =
  | { t: "auth"; proof: string }
  /** authProof(token, …) with the token from an earlier `session`, instead of a code. */
  | { t: "resume"; proof: string }
  | { t: "auth-ok" }
  /** Sent after `auth-ok`: a token the guest may use to `resume` while this CLI runs. */
  | { t: "session"; token: string }
  | { t: "auth-fail"; attemptsLeft: number }
  | { t: "req"; id: number; method: string; path: string; headers: [string, string][] }
  | { t: "res"; id: number; status: number; headers: [string, string][] }
  /** Ends the body of request or response `id`. */
  | { t: "end"; id: number }
  /** The host couldn't answer request `id` (e.g. the app threw). */
  | { t: "abort"; id: number; message: string }
  /** The guest no longer wants request `id`; the host stops sending its response. */
  | { t: "cancel"; id: number };

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

/**
 * Proof that the guest knows the code the host printed (or a resume token), bound to this connection's DTLS
 * fingerprints (`a=fingerprint` values from each side's SDP, as each side sees them). A
 * rendezvous server that swapped the SDP would see different fingerprints, so the proof fails.
 * Limitation: with a 6-digit code a man in the middle could brute-force the code offline from
 * an observed proof; a PAKE would close that. Base64url SHA-256 of the three values.
 */
export async function authProof(
  code: string,
  guestFingerprint: string,
  hostFingerprint: string,
): Promise<string> {
  const input = new TextEncoder().encode(
    ["gitui-nearby-v1", code, guestFingerprint.toLowerCase(), hostFingerprint.toLowerCase()].join(
      "\n",
    ),
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The first `a=fingerprint:` value in an SDP, e.g. "sha-256 AB:CD:…". */
export function sdpFingerprint(sdp: string): string | null {
  return /^a=fingerprint:(.+)$/m.exec(sdp)?.[1]?.trim() ?? null;
}
