// Every check on what crosses the nearby protocol's wires (nearby.ts), in one place: the
// rendezvous Worker, the CLI (host) and the web app (guest) all read messages with these. Each
// message is an Effect Schema below; decoding one keeps only the contract's fields, so nothing
// else is relayed or trusted. The decode* functions throw a NearbyCodecError that says what is
// wrong (each schema's `message` annotations); the parse* wrappers return null instead. A new
// protocol field goes into its schema here, and into its type in nearby.ts, which the
// assertions at the end of the schemas keep in step. Pure, with nothing beyond what browsers,
// Node and Workers all have; it imports no curve code, so the Worker's bundle doesn't either.
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { fromBase64Url } from "./bytes.ts";
import { issueMessage, withMessage } from "./schema-messages.ts";
import {
  AUTH_ATTEMPTS,
  type ChannelMessage,
  type ClientMessage,
  ERROR_CODES,
  isErrorCode,
  isHostName,
  isRefusalReason,
  type Fingerprint,
  type GuestMessage,
  HOST_KEY,
  HOST_SECRET,
  type HostInfo,
  type HostMessage,
  type IceCandidate,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  OFFER_ID,
  parseChunk,
  PEER_ID,
  REASON_SLUG,
  REFUSAL_REASONS,
  type RelayedSignal,
  RENDEZVOUS_PATH,
  type ServerMessage,
  type SignalData,
  UNSAFE_CHARS,
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

// ── Decoding ───────────────────────────────────────────────────────────────────────────────

/**
 * A decoder for `schema` that throws a NearbyCodecError with the issue's reason, or with
 * `otherwise(input)` if it has none (a top-level union none of whose members' tags match).
 */
function decoder<S extends Schema.Decoder<unknown>>(
  schema: S,
  otherwise: (input: unknown) => string = () => "invalid message",
): (input: unknown) => S["Type"] {
  // The first failure is all a decoder reports.
  const decode = SchemaParser.decodeUnknownResult(schema, { errors: "first" });
  return (input) => {
    const result = decode(input);
    if (Result.isSuccess(result)) return result.success;
    return fail(issueMessage(result.failure) ?? otherwise(input));
  };
}

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

// ── Values ─────────────────────────────────────────────────────────────────────────────────

/** A string, "`what` isn't a string" otherwise; "invalid `what`" unless it matches `pattern`. */
const text = (what: string, pattern?: RegExp) =>
  pattern
    ? withMessage(
        Schema.String,
        `${what} isn't a string`,
        Schema.isPattern(pattern, { message: `invalid ${what}` }),
      )
    : withMessage(Schema.String, `${what} isn't a string`);

/** A whole number from `minimum` to `maximum`; `message` for anything else. */
const integer = (minimum: number, maximum: number, message: string) =>
  withMessage(
    Schema.Number,
    message,
    Schema.isInt({ message }),
    Schema.isBetween({ minimum, maximum }, { message }),
  );

/** A request id: an unsigned 32-bit integer, as body frames carry it. */
const RequestId = integer(0, 0xffff_ffff, "no request id");
export const isId: (value: unknown) => value is number = Schema.is(RequestId);

/** HTTP headers as name/value pairs. */
const Headers = withMessage(
  Schema.mutable(Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String])))),
  "invalid headers",
);
export const isHeaders: (value: unknown) => value is [string, string][] = Schema.is(Headers);

/** The longest text `printable` returns, in code points. */
export const MAX_PRINTABLE_LENGTH = 500;

/**
 * `text` safe to print where it may quote others (a terminal, a log): without the characters
 * that hostName refuses, and cut to `max` code points, ending in "…" if it was cut.
 */
export function printable(text: string, max = MAX_PRINTABLE_LENGTH): string {
  const kept = Array.from(text.replace(UNSAFE_CHARS, ""));
  return kept.length > max ? `${kept.slice(0, max - 1).join("")}…` : kept.join("");
}

/**
 * A host's display name, trimmed, if it is 1 to MAX_NAME_LENGTH code points long and has no
 * control or bidi characters.
 */
const HostName = withMessage(Schema.String, "invalid name")
  .pipe(
    Schema.decodeTo(
      withMessage(
        Schema.String,
        "invalid name",
        Schema.makeFilter(isHostName, { message: "invalid name" }),
      ),
      SchemaTransformation.trim(),
    ),
  )
  .annotateKey({ messageMissingKey: "invalid name" });
const decodeHostName = Schema.decodeUnknownOption(HostName);

/**
 * A host's display name, trimmed, if it is 1 to MAX_NAME_LENGTH code points long and has no
 * control or bidi characters; else null. The Worker, `--name` and saved hosts all use this.
 */
export const hostName = (value: unknown): string | null => Option.getOrNull(decodeHostName(value));

/**
 * `text` made into a valid hostName if it can be: the unsafe characters dropped and the rest cut
 * to MAX_NAME_LENGTH code points. Null if nothing is left.
 */
export function toHostName(text: string): string | null {
  const kept = Array.from(text.replace(UNSAFE_CHARS, "").trim()).slice(0, MAX_NAME_LENGTH);
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

/**
 * A string `from` decodes, as one of the `known` values, or as `unknown` if it's none of them:
 * a newer peer's, which still decodes.
 */
function open<K extends string>(
  from: Schema.Codec<string>,
  known: readonly K[],
  isKnown: (value: string) => value is K,
) {
  return from
    .pipe(
      Schema.decodeTo(
        Schema.Literals([...known, "unknown" as const]),
        SchemaTransformation.transform({
          decode: (value: string): K | "unknown" => (isKnown(value) ? value : "unknown"),
          encode: (value: K | "unknown"): string => value,
        }),
      ),
    )
    .annotateKey({ messageMissingKey: from.ast.context?.annotations?.messageMissingKey });
}

// ── Rendezvous messages ────────────────────────────────────────────────────────────────────

const PeerId = text("peer id", PEER_ID);
const OfferId = text("offerId", OFFER_ID);
const Sdp = withMessage(
  Schema.String,
  "sdp isn't a string",
  Schema.isMaxLength(MAX_MESSAGE_LENGTH, { message: "sdp too long" }),
);

const Candidate = withMessage(
  Schema.Struct({
    candidate: text("candidate line"),
    sdpMid: Schema.optionalKey(withMessage(Schema.NullishOr(Schema.String), "invalid sdpMid")),
    sdpMLineIndex: Schema.optionalKey(
      withMessage(
        Schema.NullishOr(integer(0, 0xffff, "invalid sdpMLineIndex")),
        "invalid sdpMLineIndex",
      ),
    ),
  }),
  "candidate isn't an object",
);

/** `resume` is kept only when true; anything else means no. */
const Resume = Schema.optionalKey(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.optionalKey(Schema.Literal(true)),
    SchemaTransformation.transformOptional<true, unknown>({
      decode: Option.filter((resume): resume is true => resume === true),
      encode: (resume) => resume,
    }),
  ),
);

/** A WebRTC signal, with `Reason` as a refusal's reason. */
function signal<R extends Schema.Top>(Reason: R) {
  return withMessage(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("offer"), offerId: OfferId, sdp: Sdp, resume: Resume }),
      Schema.Struct({ kind: Schema.Literal("answer"), offerId: OfferId, sdp: Sdp }),
      Schema.Struct({ kind: Schema.Literal("candidate"), offerId: OfferId, candidate: Candidate }),
      Schema.Struct({ kind: Schema.Literal("refused"), offerId: OfferId, reason: Reason }),
    ]),
    "unknown signal kind",
  );
}

const ReasonSlug = text("reason", REASON_SLUG);
/** A WebRTC signal as the rendezvous relays it: a refusal's reason is any REASON_SLUG. */
export const RelayedSignalSchema = signal(ReasonSlug);
/** A WebRTC signal as its receiver reads it: a reason this version doesn't know is `unknown`. */
export const SignalSchema = signal(open(ReasonSlug, REFUSAL_REASONS, isRefusalReason));

/** A message's `data`: a signal. */
const SignalField = <S extends Schema.Top>(signal: S): S["Rebuild"] =>
  signal.annotateKey({ messageMissingKey: "signal isn't an object" });

/** A message a peer sends the rendezvous. RENDEZVOUS_PING isn't one. */
export const ClientMessageSchema = Schema.Union([
  withMessage(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("hello"),
        role: Schema.Literal("host"),
        name: HostName,
        secret: text("secret", HOST_SECRET),
      }),
      Schema.Struct({ type: Schema.Literal("hello"), role: Schema.Literal("guest") }),
    ]),
    "invalid role",
  ),
  Schema.Struct({
    type: Schema.Literal("signal"),
    to: PeerId,
    data: SignalField(RelayedSignalSchema),
  }),
]);

export const HostInfoSchema = withMessage(
  Schema.Struct({ id: PeerId, name: HostName, key: text("key", HOST_KEY) }),
  "host isn't an object",
);
const parseHost = Schema.decodeUnknownOption(HostInfoSchema);

/** A message from the rendezvous. Hosts that break the contract are left out. */
export const ServerMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("welcome"), id: PeerId }),
  Schema.Struct({
    type: Schema.Literal("hosts"),
    hosts: withMessage(Schema.Array(Schema.Unknown), "hosts isn't an array").pipe(
      Schema.decodeTo(
        Schema.mutable(Schema.Array(Schema.toType(HostInfoSchema))),
        SchemaTransformation.transform({
          decode: (hosts) => hosts.flatMap((host) => Option.toArray(parseHost(host))),
          encode: (hosts): readonly unknown[] => hosts,
        }),
      ),
      // Key annotations don't reach through decodeTo: the outer schema needs its own.
      Schema.annotateKey({ messageMissingKey: "hosts isn't an array" }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("signal"), from: PeerId, data: SignalField(SignalSchema) }),
  Schema.Struct({ type: Schema.Literal("gone"), id: PeerId }),
  Schema.Struct({
    type: Schema.Literal("error"),
    // A code this version doesn't know is a newer rendezvous's: still an error.
    code: open(text("error code"), ERROR_CODES, isErrorCode),
    message: text("error message").pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (message) => message.slice(0, 500),
          encode: (message) => message,
        }),
      ),
      Schema.annotateKey({ messageMissingKey: "error message isn't a string" }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("pong") }),
]);

const decodeRelayed = decoder(RelayedSignalSchema);
const decodeSignalData = decoder(SignalSchema);
const decodeClient = decoder(ClientMessageSchema, () => "unknown message type");
const decodeServer = decoder(ServerMessageSchema, () => "unknown message type");

/** A WebRTC signal as the rendezvous relays it (RelayedSignal). */
export const decodeRelayedSignal = (value: unknown): RelayedSignal =>
  decodeRelayed(record(value, "signal"));

/** A WebRTC signal as its receiver reads it (SignalData). */
export const decodeSignal = (value: unknown): SignalData =>
  decodeSignalData(record(value, "signal"));

/** A message a peer sends the rendezvous (ClientMessage). RENDEZVOUS_PING isn't one. */
export function decodeClientMessage(text: string): ClientMessage {
  if (text.length > MAX_MESSAGE_LENGTH) return fail("message too long");
  return decodeClient(record(json(text), "message"));
}

/** A message from the rendezvous (ServerMessage). Hosts that break the contract are left out. */
export function decodeServerMessage(text: string): ServerMessage {
  return decodeServer(record(json(text), "message"));
}

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
const bytes32 = (what: string) =>
  withMessage(
    Schema.String,
    `${what} isn't a string`,
    Schema.makeFilter((text: string) => fromBase64Url(text, 32) !== null, {
      message: `invalid ${what}`,
    }),
  );
const Share = bytes32("share");
const Tag = bytes32("tag");
const Proof = bytes32("proof");

/** A resume nonce: 16 to 48 bytes, base64url. */
const NONCE = /^[\w-]{22,64}$/;
/** An HTTP method (RFC 9110 token). */
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER_ORIGIN = "http://gitui.invalid";

/** A path a request may name: absolute, and naming no other host (`//host/…`, `/\host/…`). */
function isPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  try {
    return new URL(value, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
}

const tagged = <const T extends string, const F extends Schema.Struct.Fields>(t: T, fields: F) =>
  Schema.Struct({ t: Schema.Literal(t), ...fields });

/** JSON text messages the guest sends on the data channel. */
export const GuestMessageSchema = Schema.Union([
  tagged("pake", { y: Share }),
  tagged("pake-confirm", { confirm: Tag }),
  tagged("pake-fail", {}),
  tagged("resume", { nonce: text("nonce", NONCE), proof: Proof }),
  tagged("req", {
    id: RequestId,
    method: withMessage(
      Schema.String,
      "invalid method",
      Schema.isPattern(METHOD, { message: "invalid method" }),
    ),
    path: withMessage(
      Schema.String,
      "invalid path",
      Schema.makeFilter(isPath, { message: "invalid path" }),
    ),
    headers: Headers,
  }),
  tagged("end", { id: RequestId }),
  tagged("cancel", { id: RequestId }),
]);

const AttemptsLeft = integer(0, AUTH_ATTEMPTS, "invalid attemptsLeft");

/** JSON text messages the host sends on the data channel. */
export const HostMessageSchema = Schema.Union([
  tagged("pake", { y: Share, confirm: Tag }),
  tagged("resume-ok", { proof: Proof }),
  tagged("auth-ok", {}),
  tagged("session", { token: bytes32("token") }),
  // `locked` is kept only as true, on a last failure (attemptsLeft 0).
  tagged("auth-fail", {
    attemptsLeft: AttemptsLeft,
    locked: Schema.optionalKey(Schema.Unknown),
  }).pipe(
    Schema.decodeTo(
      tagged("auth-fail", {
        attemptsLeft: Schema.toType(AttemptsLeft),
        locked: Schema.optionalKey(Schema.Literal(true)),
      }),
      SchemaTransformation.transform({
        decode: ({ attemptsLeft, locked }) =>
          attemptsLeft === 0 && locked === true
            ? { t: "auth-fail" as const, attemptsLeft, locked: true as const }
            : { t: "auth-fail" as const, attemptsLeft },
        encode: (message) => message,
      }),
    ),
  ),
  tagged("res", {
    id: RequestId,
    status: integer(100, 599, "invalid status"),
    headers: Headers,
  }),
  tagged("end", { id: RequestId }),
  tagged("abort", { id: RequestId, message: text("abort message") }),
]);

const unexpected = (m: unknown) => `unexpected message ${JSON.stringify((m as { t?: unknown }).t)}`;
const decodeGuest = decoder(GuestMessageSchema, unexpected);
const decodeHost = decoder(HostMessageSchema, unexpected);

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
    const message: ChannelMessage = from === "guest" ? decodeGuest(m) : decodeHost(m);
    return { kind: "message", message };
  } catch (e) {
    if (!(e instanceof NearbyCodecError)) throw e;
    return { kind: "invalid", id: isId(m.id) ? m.id : null, reason: e.message };
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────────────────
// The types in nearby.ts are the contract's documentation; these keep each schema's type and
// its type there the same (readonly aside), so a field in one and not the other doesn't compile.

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Equals<A, B> =
  (<X>() => X extends Mutable<A> ? 1 : 2) extends <X>() => X extends Mutable<B> ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type SchemasMatchContract = [
  Assert<Equals<IceCandidate, (typeof Candidate)["Type"]>>,
  Assert<Equals<HostInfo, (typeof HostInfoSchema)["Type"]>>,
  Assert<Equals<RelayedSignal, (typeof RelayedSignalSchema)["Type"]>>,
  Assert<Equals<SignalData, (typeof SignalSchema)["Type"]>>,
  Assert<Equals<ClientMessage, (typeof ClientMessageSchema)["Type"]>>,
  Assert<Equals<ServerMessage, (typeof ServerMessageSchema)["Type"]>>,
  Assert<Equals<GuestMessage, (typeof GuestMessageSchema)["Type"]>>,
  Assert<Equals<HostMessage, (typeof HostMessageSchema)["Type"]>>,
];

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
  return match ? (`sha-256 ${match[1]!.toLowerCase()}` as Fingerprint) : null;
}
