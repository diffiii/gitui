// The API, on Effect's HttpRouter: each route is an Effect that answers JSON. Each route
// declares schemas for its query and body, decoded before it runs, whose messages are the 400s'
// errors; a GitError is a 400, a RepoNotOpenedError a 403 with REPO_NOT_OPENED, and anything
// else a 500 that says only that.
// createApp gives the routes as a layer, which main.ts serves on a Node server and `toFetch`
// turns into the web handler that the nearby bridge (and tests) call.
// The routes are @gitui/shared's API contract, served: ROUTES has one per key, and `route` and
// `repoRoute` hold each one's schemas and answer to the contract for its key.
import os from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  API,
  type ApiKey,
  type ApiTypes,
  type Ok,
  type OkOutput,
  type ParamsOf,
  type RemoteAction,
  REPO_NOT_OPENED,
  type RepoApiKey,
  type ResponseOf,
} from "@gitui/shared";
import {
  ByteSize,
  Cause,
  Data,
  Effect,
  Layer,
  Schema,
  SchemaTransformation,
  type Scope,
} from "effect";
import {
  type FindMyWay,
  type HttpMethod,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { type AccessOptions, access } from "./access.ts";
import { CONFIG_DIR, readRecent } from "./config.ts";
import { untrackedDiff, workingFile, workingFiles } from "./files.ts";
import * as g from "./git.ts";
import { applyLines, diffBase } from "./lines.ts";
import { lockedWrite } from "./lock.ts";
import { type RepoGate, type RepoNotOpenedError, repoGate } from "./repo-scope.ts";
import { VERSION } from "./version.ts";
import { issueMessage, withMessage } from "./schema-messages.ts";

export interface AppOptions extends AccessOptions {
  initialRepo?: string;
  /** Where the recent list lives; tests pass a temp dir. */
  configDir?: string;
}

/** A response other than a route's own: a refusal before it ran, or no route at all. */
class HttpError extends Data.TaggedError("HttpError")<{ status: number; error: string }> {}

type AppError = g.GitError | RepoNotOpenedError | HttpError;

// ---------------------------------------------------------------- requests

/** A string that passes `valid`; anything else is "Invalid <field>". */
const checkedString = (field: string, valid: (v: string) => boolean) =>
  withMessage(
    Schema.String,
    `Invalid ${field}`,
    Schema.makeFilter(valid, { message: `Invalid ${field}` }),
  );

/** A ref, branch or hash: anything git could parse as an option is refused. */
const Ref = (field = "ref") =>
  checkedString(field, (v) => v !== "" && !v.startsWith("-") && !/[\0\n]/.test(v));

const isFilePath = (v: string) => v !== "" && !v.includes("\0");

/** A single repo-relative path; may not be empty or contain NUL. */
const FilePath = (field = "path") => checkedString(field, isFilePath);

/** A path to read from the working copy: relative, never stepping up with `..`, and no folder. */
const WorkingPath = checkedString("path", (p) => {
  const parts = p.split(/[/\\]/);
  return isFilePath(p) && !path.isAbsolute(p) && !parts.includes("..") && !parts.includes("");
});

/** A string field; an absent one is `fallback`. */
const Str = (field: string, fallback: string) =>
  withMessage(Schema.String, `Invalid ${field}`).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
  );

/** An optional boolean; an absent field is `fallback`. */
const Flag = (field: string, fallback = false) =>
  withMessage(Schema.Boolean, `Invalid ${field}`).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
  );

/** `undefined` means "all files"; otherwise a non-empty list of paths. */
const PathList = Schema.optionalKey(
  withMessage(
    Schema.mutable(Schema.Array(FilePath("paths"))),
    "Invalid paths",
    Schema.isMinLength(1, { message: "Invalid paths" }),
  ),
);

/** A JSON object body with `fields`; anything else is "Invalid JSON body". */
const Body = <F extends Schema.Struct.Fields>(fields: F) =>
  withMessage(Schema.Struct(fields), "Invalid JSON body");

const FileStatusBody = withMessage(
  Schema.Struct({
    path: FilePath("file.path"),
    origPath: Schema.optionalKey(FilePath("file.origPath")),
    x: Str("file.x", "."),
    y: Str("file.y", "."),
    untracked: Flag("file.untracked"),
    conflicted: Flag("file.conflicted"),
  }),
  "Invalid file",
);

const OpenBody = Body({ path: withMessage(Schema.String, "Invalid path") });
const PathsBody = Body({ paths: PathList });
const DiscardBody = Body({ file: FileStatusBody });
const CommitBody = Body({
  message: withMessage(Schema.String, "Invalid message"),
  amend: Flag("amend"),
});
const CheckoutBody = Body({ name: Ref("branch"), remote: Flag("remote") });
const BranchBody = Body({
  name: Ref("branch"),
  from: Schema.optionalKey(Schema.Union([Schema.Literal(""), Ref("from")])),
  checkout: Flag("checkout", true),
});
const DeleteBranchBody = Body({ name: Ref("branch"), force: Flag("force") });

/** The most line numbers a side of a line selection may name. */
const MAX_SELECTED_LINES = 100_000;

/** A list of line numbers, each a positive integer. */
const LineNumbers = (field: string) =>
  withMessage(
    Schema.mutable(
      Schema.Array(
        withMessage(
          Schema.Number,
          `Invalid ${field}`,
          Schema.isInt({ message: `Invalid ${field}` }),
          Schema.isGreaterThanOrEqualTo(1, { message: `Invalid ${field}` }),
        ),
      ),
    ),
    `Invalid ${field}`,
    Schema.isMaxLength(MAX_SELECTED_LINES, { message: `Too many ${field}` }),
  );

const LinesBody = Body({
  path: FilePath(),
  action: withMessage(Schema.Literals(["stage", "unstage", "discard"]), "Invalid action"),
  base: checkedString("base", (v) => /^[0-9a-f]{64}$/.test(v)),
  lines: withMessage(
    Schema.Struct({
      deletions: LineNumbers("lines.deletions"),
      additions: LineNumbers("lines.additions"),
    }),
    "Invalid lines",
  ),
});

/** `input` decoded with `schema`, or a GitError with the schema's message for what's wrong. */
const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((e) => g.gitError(issueMessage(e.issue) ?? "Invalid request")),
  );

/** A query flag: "1" is true, anything else (or nothing) false. */
const QueryFlag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({ decode: (v) => v === "1", encode: (b) => (b ? "1" : "0") }),
  ),
  Schema.withDecodingDefaultKey(Effect.succeed("0")),
);

/** The most commits /log lists, and how many when the query doesn't say. */
const MAX_LOG = 5000;
const DEFAULT_LOG = 300;

/** A positive count of commits, at most MAX_LOG (more is cut to it). */
const LogLimit = checkedString("limit", (v) => /^[1-9][0-9]{0,8}$/.test(v)).pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transform({
      decode: (v) => Math.min(Number(v), MAX_LOG),
      encode: String,
    }),
  ),
  Schema.withDecodingDefaultKey(Effect.succeed(String(DEFAULT_LOG))),
);

/** An optional field where an empty string means absent, as the web app may send one. */
const orEmpty = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.optionalKey(Schema.Union([Schema.Literal(""), schema]));

const DiffQuery = Schema.Struct({
  // Checked in the route: an untracked file's path must be a WorkingPath.
  path: withMessage(Schema.String, "Invalid path"),
  origPath: orEmpty(FilePath("origPath")),
  staged: QueryFlag,
  untracked: QueryFlag,
});
const LogQuery = Schema.Struct({ limit: LogLimit, all: QueryFlag, ref: orEmpty(Ref()) });
const FileQuery = Schema.Struct({ path: WorkingPath });

/** The largest request body read; every body the API takes is a small JSON object. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Whether the request says its body is JSON. */
const isJson = (req: HttpServerRequest.HttpServerRequest) =>
  req.headers["content-type"]?.split(";", 1)[0]!.trim().toLowerCase() === "application/json";

/**
 * The request's JSON body, decoded with `schema`. It must say it is JSON (a page can't send that
 * cross-origin without a preflight) and be at most MAX_BODY_BYTES; malformed JSON is a client
 * error too.
 */
const readBody = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    if (!isJson(req)) {
      return yield* new HttpError({ status: 415, error: "Expected an application/json body" });
    }
    const json = yield* req.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.mapError((e) =>
        e._tag === "HttpServerError" &&
        e.reason._tag === "RequestParseError" &&
        e.reason.reason === "BodyTooLarge"
          ? new HttpError({ status: 413, error: "Request body too large" })
          : g.gitError("Invalid JSON body"),
      ),
    );
    return yield* decode(schema, json);
  });

/** The request's query parameters, each the first of its name if it repeats. */
const queryParams = Effect.map(HttpServerRequest.ParsedSearchParams, (params) =>
  Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      typeof value === "string" ? value : value[0],
    ]),
  ),
);

// ---------------------------------------------------------------- responses

const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status });

/**
 * `route`'s response, with its failures as the JSON errors the web app reads. An unexpected
 * failure is logged, and its client gets only a fixed message: what went wrong inside isn't
 * theirs to read.
 */
const respond = <R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, AppError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  route.pipe(
    Effect.catchTags({
      GitError: (e) => Effect.succeed(json({ error: e.message }, 400)),
      // REPO_NOT_OPENED lets the UI tell this case apart.
      RepoNotOpenedError: (e) =>
        Effect.succeed(json({ error: e.message, code: REPO_NOT_OPENED }, 403)),
      HttpError: (e) => Effect.succeed(json({ error: e.error }, e.status)),
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.as(
            Effect.logError("Unexpected error in an API route", cause),
            json({ error: "Internal server error" }, 500),
          ),
    ),
  );

// ---------------------------------------------------------------- routes

/** What a route may use: the request, its path and query parameters, and the Node services. */
type RouteServices =
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
  | HttpRouter.RouteContext
  | NodeServices.NodeServices;

/** What the routes share in one app. */
interface AppContext {
  opts: AppOptions;
  configDir: string;
  repos: RepoGate;
  /** The server's scope, which a locked write runs in (lockedWrite). */
  scope: Scope.Scope;
}

type Answer = Effect.Effect<unknown, AppError, RouteServices>;

/** What the route for `K` answers: the contract's response for it, or one of the app's errors. */
type RouteAnswer<K extends ApiKey> = Effect.Effect<ResponseOf<K>, AppError, RouteServices>;

/** An API route: its method, its path, and its answer in an app. */
export interface ApiRoute {
  method: HttpMethod.HttpMethod;
  path: HttpRouter.PathInput;
  handle: (
    app: AppContext,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RouteServices>;
}

/** What a route reads from its request besides the path: a query and a JSON body. */
interface Inputs<Q extends Schema.Decoder<unknown>, B extends Schema.Decoder<unknown>> {
  /** The query parameters' schema; without one, the route reads none. */
  query?: Q;
  /** The body's schema; without one, the route reads no body (and takes any). */
  body?: B;
}

const NoQuery = Schema.Struct({});

/** The contract's query for `K` (`{}` for none) and its body (`undefined` for none). */
type ContractQuery<K extends ApiKey> = ApiTypes[K] extends { query: infer Q } ? Q : {};
type ContractBody<K extends ApiKey> = ApiTypes[K] extends { body: infer B } ? B : undefined;

type Mutable<T> = T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;
type Equals<A, B> =
  (<X>() => X extends Mutable<A> ? 1 : 2) extends <X>() => X extends Mutable<B> ? 1 : 2
    ? true
    : false;

/**
 * Whether a query schema that decodes to `T` reads the contract's query for `K`. A query travels
 * as strings, so its decoded side is compared with what the client passes before encoding: the
 * same keys, and every value the client may pass reads as the type the route gets.
 */
type QueryMatches<K extends ApiKey, T> =
  Equals<keyof ContractQuery<K>, keyof T> extends true
    ? [Required<ContractQuery<K>>] extends [T]
      ? true
      : false
    : false;

/**
 * Nothing more when a route's schemas match the contract for `K`, and otherwise an input no
 * schema is, so the route's own line fails the type check. A body's schema reads the JSON the
 * web sends, so its wire side (`Encoded`, where a key with a default is optional) equals the
 * contract's body.
 */
type Matching<
  K extends ApiKey,
  Q extends Schema.Decoder<unknown>,
  B extends Schema.Decoder<unknown>,
> = (QueryMatches<K, Q["Type"]> extends true ? unknown : { query: "does not match the contract" }) &
  (Equals<B["Encoded"], ContractBody<K>> extends true
    ? unknown
    : { body: "does not match the contract" });

/** A route's inputs, decoded, and its path parameters (the ones its contract path names). */
interface Decoded<
  K extends ApiKey,
  Q extends Schema.Decoder<unknown>,
  B extends Schema.Decoder<unknown>,
> {
  query: Q["Type"];
  body: B["Type"];
  params: { readonly [N in keyof ParamsOf<K>]?: string };
}

/**
 * The request's inputs, decoded: the whole body is read here, in the request's fiber, so a
 * slow client holds up nothing but its own request.
 */
const decodeInputs = <
  K extends ApiKey,
  Q extends Schema.Decoder<unknown>,
  B extends Schema.Decoder<unknown>,
>({
  query,
  body,
}: Inputs<Q, B>) =>
  Effect.gen(function* () {
    const decoded: Decoded<K, Q, B> = {
      query: query ? yield* decode(query, yield* queryParams) : {},
      body: body ? yield* readBody(body) : undefined,
      params: yield* HttpRouter.params,
    };
    return decoded;
  });

const apiRoute = (
  method: ApiRoute["method"],
  path: HttpRouter.PathInput,
  answer: (app: AppContext) => Answer,
): ApiRoute => ({
  method,
  path,
  handle: (app) => respond(Effect.map(answer(app), (v) => json(v))),
});

/**
 * The contract's endpoint `key` outside /api/repo, given its decoded inputs. Its schemas must
 * match the contract's query and body for `key`, and its answer the contract's response.
 * (Exported for api-contract.test.ts.)
 */
export const route = <
  K extends Exclude<ApiKey, RepoApiKey>,
  Q extends Schema.Decoder<unknown> = typeof NoQuery,
  B extends Schema.Decoder<unknown> = Schema.Undefined,
>(
  key: K,
  { query, body }: Inputs<Q, B> & NoInfer<Matching<K, Q, B>>,
  answer: (input: Decoded<K, Q, B>, app: AppContext) => RouteAnswer<K>,
): ApiRoute =>
  apiRoute(API[key].method, API[key].path, (app) =>
    Effect.flatMap(decodeInputs<K, Q, B>({ query, body }), (i) => answer(i, app)),
  );

/**
 * The contract's endpoint `key` under /api/repo, on the repository in `?repo=`, through the
 * gate, then given its decoded inputs, which must match the contract as `route`'s do. A
 * repository path that comes any other way (a body field) must go through `repos.resolve` as
 * well.
 *
 * With `lock` (every write), it runs under `lockedWrite`. Its inputs are read before that, so
 * the lock covers only git. Any other route stops when its client goes away, git included.
 * (Exported for api-contract.test.ts.)
 */
export const repoRoute = <
  K extends RepoApiKey,
  Q extends Schema.Decoder<unknown> = typeof NoQuery,
  B extends Schema.Decoder<unknown> = Schema.Undefined,
>(
  key: K,
  { lock = false, query, body }: Inputs<Q, B> & { lock?: boolean } & NoInfer<Matching<K, Q, B>>,
  answer: (repo: string, input: Decoded<K, Q, B>) => RouteAnswer<K>,
): ApiRoute =>
  apiRoute(API[key].method, API[key].path, ({ repos, scope }) =>
    Effect.gen(function* () {
      const input = (yield* queryParams).repo;
      if (!input) return yield* new HttpError({ status: 400, error: "Missing repo" });
      const repo = yield* repos.resolve(input);
      const work = answer(repo, yield* decodeInputs<K, Q, B>({ query, body }));
      if (!lock) return yield* work;
      return yield* lockedWrite(repo, work, scope);
    }),
  );

const ok: Ok = { ok: true };
const okOutput = (output: string): OkOutput => ({ ok: true, output });

/**
 * A remote operation. Fetch and push leave the index alone, and may take long: no lock, so
 * they stop when their client goes away.
 */
const remote = (action: RemoteAction) =>
  repoRoute(action, { lock: action === "pull" }, (repo) =>
    Effect.map(g.remoteAction(repo, action), okOutput),
  );

/**
 * Every method but HEAD, which the router sends to the GET route of the path when no route has
 * HEAD: a catch-all on HEAD would shadow every GET route.
 */
const ANY_BUT_HEAD = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

// The hosted page reads this JSON 404 as an outdated CLI (api.ts): answer 404 only for routes
// that don't exist.
const notFound = () => Effect.fail(new HttpError({ status: 404, error: "Not found" }));

/**
 * The JSON 404 for `method` on any path under /api that no route of the contract has. It is no
 * endpoint of the contract, so it isn't one of ROUTES.
 */
const catchAll = (method: (typeof ANY_BUT_HEAD)[number]): ApiRoute =>
  apiRoute(method, "/api/*", notFound);

/** Every endpoint of the contract (@gitui/shared's API), served, and nothing else. */
const ROUTES = {
  config: route("config", {}, (_, { opts, configDir }) =>
    Effect.gen(function* () {
      return {
        initialRepo: opts.initialRepo ?? null,
        recent: yield* readRecent(configDir),
        home: os.homedir(),
        version: VERSION,
      };
    }),
  ),
  open: route("open", { body: OpenBody }, ({ body }, { repos }) =>
    Effect.map(repos.open(body.path), (root) => ({ root, name: path.basename(root) })),
  ),

  status: repoRoute("status", {}, g.status),
  diff: repoRoute("diff", { query: DiffQuery }, (repo, { query }) =>
    query.untracked
      ? Effect.flatMap(decode(WorkingPath, query.path), (file) => untrackedDiff(repo, file))
      : Effect.flatMap(decode(FilePath(), query.path), (file) =>
          Effect.map(
            g.fileDiff(repo, {
              path: file,
              origPath: query.origPath || undefined,
              staged: query.staged,
            }),
            // `applyLines` takes lines of the whole diff only, as it computes it again.
            ({ diff, truncated }) =>
              truncated ? { diff, truncated } : { diff, truncated, base: diffBase(diff) },
          ),
        ),
  ),
  applyLines: repoRoute("applyLines", { body: LinesBody, lock: true }, (repo, { body }) =>
    Effect.as(applyLines(repo, body), ok),
  ),
  stage: repoRoute("stage", { body: PathsBody, lock: true }, (repo, { body }) =>
    Effect.as(g.stage(repo, body.paths), ok),
  ),
  unstage: repoRoute("unstage", { body: PathsBody, lock: true }, (repo, { body }) =>
    Effect.as(g.unstage(repo, body.paths), ok),
  ),
  discard: repoRoute("discard", { body: DiscardBody, lock: true }, (repo, { body }) =>
    Effect.as(g.discard(repo, body.file.path), ok),
  ),
  commit: repoRoute("commit", { body: CommitBody, lock: true }, (repo, { body }) =>
    !body.message.trim() && !body.amend
      ? Effect.fail(g.gitError("Commit message is empty"))
      : Effect.map(g.commit(repo, body.message, body.amend), okOutput),
  ),
  lastMessage: repoRoute("lastMessage", {}, (repo) =>
    Effect.map(g.lastCommitMessage(repo), (message) => ({ message })),
  ),
  log: repoRoute("log", { query: LogQuery }, (repo, { query }) =>
    Effect.map(
      g.log(repo, { limit: query.limit, all: query.all, ref: query.ref || undefined }),
      (commits) => ({ commits }),
    ),
  ),
  showCommit: repoRoute("showCommit", {}, (repo, { params }) =>
    Effect.flatMap(decode(Ref("hash"), params.hash), (hash) => g.showCommit(repo, hash)),
  ),
  files: repoRoute("files", {}, (repo) => workingFiles(repo)),
  file: repoRoute("file", { query: FileQuery }, (repo, { query }) => workingFile(repo, query.path)),
  branches: repoRoute("branches", {}, (repo) =>
    Effect.map(g.branches(repo), (branches) => ({ branches })),
  ),
  checkout: repoRoute("checkout", { body: CheckoutBody, lock: true }, (repo, { body }) =>
    Effect.as(g.checkout(repo, body.name, body.remote), ok),
  ),
  createBranch: repoRoute("createBranch", { body: BranchBody, lock: true }, (repo, { body }) =>
    Effect.as(g.createBranch(repo, body.name, body.from || undefined, body.checkout), ok),
  ),
  deleteBranch: repoRoute(
    "deleteBranch",
    { body: DeleteBranchBody, lock: true },
    (repo, { body }) => Effect.as(g.deleteBranch(repo, body.name, body.force), ok),
  ),
  fetch: remote("fetch"),
  pull: remote("pull"),
  push: remote("push"),
} satisfies { [K in ApiKey]: ApiRoute };

/** Every API route. Tests list them from here; `createApp` serves them. */
export const API_ROUTES: readonly ApiRoute[] = [
  ...Object.values(ROUTES),
  // Unknown API routes (and /api itself) get a JSON 404: the router falls back to these for
  // paths under /api/repo too, an OPTIONS preflight on a POST route included (app-guard.test.ts).
  ...ANY_BUT_HEAD.map(catchAll),
];

/**
 * How the router matches paths: exactly as written, as they did under Hono, so `/API/config`,
 * `//api/config` and `/api/config/` match no route. (The access middleware refuses what the
 * router would still rewrite, percent escapes and `;`, and other spellings that aren't the one
 * way: `#`, `\` and `//`.)
 */
export const ROUTER_CONFIG = {
  caseSensitive: true,
  ignoreDuplicateSlashes: false,
  ignoreTrailingSlash: false,
} satisfies Partial<FindMyWay.RouterConfig>;

/** The API's routes, behind the listener's access checks, as a layer for a router. */
export function createApp(opts: AppOptions) {
  const { middleware, repoScope } = access(opts);
  const configDir = opts.configDir ?? CONFIG_DIR;
  const repos = repoGate(repoScope, { initialRepo: opts.initialRepo, configDir });
  return Layer.unwrap(
    Effect.map(Effect.scope, (scope) => {
      const app: AppContext = { opts, configDir, repos, scope };
      return HttpRouter.addAll(
        API_ROUTES.map((r) => HttpRouter.route(r.method, r.path, r.handle(app))),
      );
    }),
  ).pipe(HttpRouter.provideRequest(NodeServices.layer), Layer.provide(middleware.layer));
}

/**
 * Routes (createApp's, or main.ts's) as a web handler, until the scope closes: the nearby
 * bridge calls the API this way, and so do tests.
 */
export const toFetch = <E>(layer: Layer.Layer<never, E, HttpRouter.HttpRouter>) =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(layer, { disableLogger: true, routerConfig: ROUTER_CONFIG }),
      ),
      ({ dispose }) => Effect.promise(dispose),
    ),
    ({ handler }) =>
      (request: Request): Promise<Response> =>
        handler(request),
  );
