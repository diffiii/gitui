// Every check on what crosses the nearby protocol's wires (nearby.ts), in one place: the
// rendezvous Worker, the CLI (host) and the web app (guest) all read messages with these. Each
// message is an Effect Schema below; decoding one keeps only the contract's fields, so nothing
// else is relayed or trusted. The decode* functions throw a NearbyCodecError that says what is
// wrong and where ("missing data.offerId"); the parse* wrappers return null instead. A new
// protocol field goes into its schema here, and into its type in nearby.ts, which the
// assertions at the end of the schemas keep in step. Pure, with nothing beyond what browsers,
// Node and Workers all have; it imports no curve code, so the Worker's bundle doesn't either.
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { fromBase64Url } from "./bytes.ts";
import {
  AUTH_ATTEMPTS,
  type ChannelMessage,
  type ClientMessage,
  ERROR_CODES,
  isErrorCode,
  isRefusalReason,
  type GuestMessage,
  HOST_KEY,
  HOST_SECRET,
  hostName,
  type HostInfo,
  type HostMessage,
  type IceCandidate,
  MAX_MESSAGE_LENGTH,
  OFFER_ID,
  parseChunk,
  PEER_ID,
  REASON_SLUG,
  REFUSAL_REASONS,
  type RelayedSignal,
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

// ── Decoding ───────────────────────────────────────────────────────────────────────────────

/**
 * What `issue`, from decoding `input`, says is wrong, as "missing <path>" or "invalid <path>":
 * the path to its first failure, e.g. "data.offerId", or "message" for the value itself.
 */
function describe(
  issue: SchemaIssue.Issue,
  input: unknown,
  path: readonly PropertyKey[] = [],
): string {
  switch (issue._tag) {
    case "Pointer": {
      const value = issue.path.reduce((at, key) => (isObject(at) ? at[key] : undefined), input);
      return describe(issue.issue, value, [...path, ...issue.path]);
    }
    case "Filter":
    case "Encoding":
      return describe(issue.issue, input, path);
    case "Composite":
      if (issue.issues.length > 0) return describe(issue.issues[0]!, input, path);
      break;
    case "AnyOf":
      if (issue.issues.length > 0) return describe(issue.issues[0]!, input, path);
      // No member has the input's tags: say which one.
      if (isObject(input)) {
        for (const [key, values] of tags(issue.ast)) {
          if (!Object.hasOwn(input, key)) return `missing ${where([...path, key])}`;
          if (!values.has(input[key])) return `invalid ${where([...path, key])}`;
        }
      }
      break;
  }
  return `${issue._tag === "MissingKey" ? "missing" : "invalid"} ${where(path)}`;
}

const where = (path: readonly PropertyKey[]) =>
  path.length > 0 ? path.map(String).join(".") : "message";

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The keys that tell `union`'s members apart, those of nested unions included, in order, each
 * with the literals its members require there.
 */
function tags(union: SchemaAST.Union): Map<PropertyKey, Set<unknown>> {
  const found = new Map<PropertyKey, Set<unknown>>();
  const visit = (ast: SchemaAST.AST): void => {
    if (SchemaAST.isUnion(ast)) return ast.types.forEach(visit);
    if (!SchemaAST.isObjects(ast)) return;
    for (const { name, type } of ast.propertySignatures) {
      if (!SchemaAST.isLiteral(type) || SchemaAST.isOptional(type)) continue;
      const values = found.get(name) ?? new Set();
      found.set(name, values.add(type.literal));
    }
  };
  visit(union);
  return found;
}

/** A decoder for `schema` that throws a NearbyCodecError saying what is wrong. */
function decoder<S extends Schema.Decoder<unknown>>(
  schema: S,
): (input: Record<string, unknown>) => S["Type"] {
  // The first failure is all a decoder reports.
  const decode = SchemaParser.decodeUnknownResult(schema, { errors: "first" });
  return (input) => {
    let result: Result.Result<S["Type"], SchemaIssue.Issue>;
    try {
      result = decode(input);
    } catch {
      // A getter that throws: only values that aren't parsed JSON have one.
      return fail("unreadable message");
    }
    return Result.isSuccess(result) ? result.success : fail(describe(result.failure, input));
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

/** A string that matches `pattern`. */
const text = (pattern: RegExp) => Schema.String.check(Schema.isPattern(pattern));

/** A whole number from `minimum` to `maximum`. */
const integer = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }));

/** A request id: an unsigned 32-bit integer, as body frames carry it. */
const RequestId = integer(0, 0xffff_ffff);
const isId: (value: unknown) => value is number = Schema.is(RequestId);

/** HTTP headers as name/value pairs. */
const Headers = Schema.mutable(
  Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
);

/**
 * A host's display name, trimmed, if it is 1 to MAX_NAME_LENGTH code points long and has no
 * control or bidi characters.
 */
const HostName = Schema.String.check(Schema.makeFilter((name) => hostName(name) !== null)).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({ decode: (name) => hostName(name)!, encode: (name) => name }),
  ),
);

/**
 * A string `from` decodes, as one of the `known` values, or as `unknown` if it's none of them:
 * a newer peer's, which still decodes.
 */
function open<K extends string>(
  from: Schema.Codec<string>,
  known: readonly K[],
  isKnown: (value: string) => value is K,
) {
  return from.pipe(
    Schema.decodeTo(
      Schema.Literals([...known, "unknown" as const]),
      SchemaTransformation.transform({
        decode: (value: string): K | "unknown" => (isKnown(value) ? value : "unknown"),
        encode: (value: K | "unknown"): string => value,
      }),
    ),
  );
}

// ── Rendezvous messages ────────────────────────────────────────────────────────────────────

const PeerId = text(PEER_ID);
const OfferId = text(OFFER_ID);
const Sdp = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

const Candidate = Schema.Struct({
  candidate: Schema.String,
  sdpMid: Schema.optionalKey(Schema.NullishOr(Schema.String)),
  sdpMLineIndex: Schema.optionalKey(Schema.NullishOr(integer(0, 0xffff))),
});

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
  return Schema.Union([
    Schema.Struct({ kind: Schema.Literal("offer"), offerId: OfferId, sdp: Sdp, resume: Resume }),
    Schema.Struct({ kind: Schema.Literal("answer"), offerId: OfferId, sdp: Sdp }),
    Schema.Struct({ kind: Schema.Literal("candidate"), offerId: OfferId, candidate: Candidate }),
    Schema.Struct({ kind: Schema.Literal("refused"), offerId: OfferId, reason: Reason }),
  ]);
}

const ReasonSlug = text(REASON_SLUG);
/** A WebRTC signal as the rendezvous relays it: a refusal's reason is any REASON_SLUG. */
const RelayedSignalSchema = signal(ReasonSlug);
/** A WebRTC signal as its receiver reads it: a reason this version doesn't know is `unknown`. */
const SignalSchema = signal(open(ReasonSlug, REFUSAL_REASONS, isRefusalReason));

/** A message a peer sends the rendezvous. RENDEZVOUS_PING isn't one. */
const ClientMessageSchema = Schema.Union([
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("hello"),
      role: Schema.Literal("host"),
      name: HostName,
      secret: text(HOST_SECRET),
    }),
    Schema.Struct({ type: Schema.Literal("hello"), role: Schema.Literal("guest") }),
  ]),
  Schema.Struct({ type: Schema.Literal("signal"), to: PeerId, data: RelayedSignalSchema }),
]);

const HostInfoSchema = Schema.Struct({ id: PeerId, name: HostName, key: text(HOST_KEY) });
const parseHost = Schema.decodeUnknownOption(HostInfoSchema);

/** A message from the rendezvous. Hosts that break the contract are left out. */
const ServerMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("welcome"), id: PeerId }),
  Schema.Struct({
    type: Schema.Literal("hosts"),
    hosts: Schema.Array(Schema.Unknown).pipe(
      Schema.decodeTo(
        Schema.mutable(Schema.Array(Schema.toType(HostInfoSchema))),
        SchemaTransformation.transform({
          decode: (hosts) => hosts.flatMap((host) => Option.toArray(parseHost(host))),
          encode: (hosts): readonly unknown[] => hosts,
        }),
      ),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("signal"), from: PeerId, data: SignalSchema }),
  Schema.Struct({ type: Schema.Literal("gone"), id: PeerId }),
  Schema.Struct({
    type: Schema.Literal("error"),
    // A code this version doesn't know is a newer rendezvous's: still an error.
    code: open(Schema.String, ERROR_CODES, isErrorCode),
    message: Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (message) => message.slice(0, 500),
          encode: (message) => message,
        }),
      ),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("pong") }),
]);

const decodeSignalData = decoder(SignalSchema);
const decodeClient = decoder(ClientMessageSchema);
const decodeServer = decoder(ServerMessageSchema);

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

/** 32 bytes in canonical base64url (CPace shares, tags, resume proofs and tokens). */
const Bytes32 = Schema.String.check(
  Schema.makeFilter((text: string) => fromBase64Url(text, 32) !== null),
);

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
const GuestMessageSchema = Schema.Union([
  tagged("pake", { y: Bytes32 }),
  tagged("pake-confirm", { confirm: Bytes32 }),
  tagged("pake-fail", {}),
  tagged("resume", { nonce: text(NONCE), proof: Bytes32 }),
  tagged("req", {
    id: RequestId,
    method: text(METHOD),
    path: Schema.String.check(Schema.makeFilter(isPath)),
    headers: Headers,
  }),
  tagged("end", { id: RequestId }),
  tagged("cancel", { id: RequestId }),
]);

const AttemptsLeft = integer(0, AUTH_ATTEMPTS);

/** JSON text messages the host sends on the data channel. */
const HostMessageSchema = Schema.Union([
  tagged("pake", { y: Bytes32, confirm: Bytes32 }),
  tagged("resume-ok", { proof: Bytes32 }),
  tagged("auth-ok", {}),
  tagged("session", { token: Bytes32 }),
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
    status: integer(100, 599),
    headers: Headers,
  }),
  tagged("end", { id: RequestId }),
  tagged("abort", { id: RequestId, message: Schema.String }),
]);

const decodeGuest = decoder(GuestMessageSchema);
const decodeHost = decoder(HostMessageSchema);

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
