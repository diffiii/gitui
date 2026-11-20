// Validation of the ClientMessage JSON that peers send to the rendezvous object (nearby.ts).
import type { ClientMessage, SignalData } from "@gitui/shared";

/**
 * Keepalive: the object answers a text message of exactly PING with PONG without waking up
 * (WebSocket hibernation auto-response). Peers may send it at any time, hello or not; it isn't a
 * ClientMessage and PONG isn't a ServerMessage.
 */
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

/** Longest accepted message, in UTF-16 code units. An SDP is a few KiB of ASCII. */
export const MAX_MESSAGE_LENGTH = 64 * 1024;

/** Longest host name, in UTF-16 code units (like `String.length`), after trimming. */
export const MAX_NAME_LENGTH = 64;

// Control characters, and the bidi controls that could make a name display as another.
const UNSAFE_NAME = /[\p{Cc}‪-‮⁦-⁩]/u;

/**
 * Parses and validates a message, or returns null. The result holds only the fields of the
 * contract, so whatever else a peer sends isn't relayed.
 */
export function parseClientMessage(text: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "hello") {
    if (value.role === "guest") return { type: "hello", role: "guest" };
    const name = value.role === "host" ? hostName(value.name) : null;
    return name === null ? null : { type: "hello", role: "host", name };
  }
  if (value.type === "signal") {
    const data = signalData(value.data);
    return typeof value.to === "string" && data ? { type: "signal", to: value.to, data } : null;
  }
  return null;
}

/** The trimmed name, if it is 1 to MAX_NAME_LENGTH long and has no control characters. */
export function hostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const ok = name !== "" && name.length <= MAX_NAME_LENGTH && !UNSAFE_NAME.test(name);
  return ok ? name : null;
}

function signalData(value: unknown): SignalData | null {
  if (!isRecord(value)) return null;
  if ((value.kind === "offer" || value.kind === "answer") && typeof value.sdp === "string") {
    return { kind: value.kind, sdp: value.sdp };
  }
  if (value.kind !== "candidate" || !isRecord(value.candidate)) return null;
  const { candidate, sdpMid, sdpMLineIndex } = value.candidate;
  if (typeof candidate !== "string") return null;
  if (sdpMid != null && typeof sdpMid !== "string") return null;
  if (sdpMLineIndex != null && !isIndex(sdpMLineIndex)) return null;
  return { kind: "candidate", candidate: { candidate, sdpMid, sdpMLineIndex } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
