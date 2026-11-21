// The API, on Effect's HttpRouter: each route is an Effect that answers JSON. Request bodies and
// parameters are decoded with the schemas below, whose messages are the 400s' errors; a
// GitError is a 400, a RepoNotOpenedError a 403 with REPO_NOT_OPENED, and anything else a 500.
// createApp gives the routes as a layer, which main.ts serves on a Node server and `toFetch`
// turns into the web handler that the nearby bridge (and tests) call.
import os from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { REPO_NOT_OPENED } from "@gitui/shared";
import { ByteSize, Cause, Data, Effect, Fiber, Layer, Schema, type Scope } from "effect";
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
import { withRepoLock } from "./lock.ts";
import { type RepoGate, type RepoNotOpenedError, repoGate } from "./repo-scope.ts";
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

/** `input` decoded with `schema`, or a GitError with the schema's message for what's wrong. */
const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((e) => g.gitError(issueMessage(e.issue) ?? "Invalid request")),
  );

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
const body = <S extends Schema.Decoder<unknown>>(schema: S) =>
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

/** The request's query parameter `name` (the first, if it repeats), as the router parsed it. */
const searchParam = (name: string) =>
  Effect.map(HttpServerRequest.ParsedSearchParams, (params): string | undefined => {
    const value = params[name];
    return typeof value === "string" ? value : value?.[0];
  });

// ---------------------------------------------------------------- responses

const json = (value: unknown, status = 200) => HttpServerResponse.jsonUnsafe(value, { status });

/** `route`'s response, with its failures as the JSON errors the web app reads. */
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
        : Effect.succeed(json({ error: String(Cause.squash(cause)) }, 500)),
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
  /** The server's scope: a mutation runs in it, so only shutting the server down stops one. */
  scope: Scope.Scope;
}

type Answer = Effect.Effect<unknown, AppError, RouteServices>;

/** An API route: its method, its path, and its answer in an app. */
export interface ApiRoute {
  method: HttpMethod.HttpMethod;
  path: HttpRouter.PathInput;
  handle: (
    app: AppContext,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RouteServices>;
}

const route = (
  method: ApiRoute["method"],
  path: HttpRouter.PathInput,
  answer: (app: AppContext) => Answer,
): ApiRoute => ({
  method,
  path,
  handle: (app) => respond(Effect.map(answer(app), (v) => json(v))),
});

/**
 * A route under /api/repo, on the repository in `?repo=`, through the gate. A repository path
 * that comes any other way (a body field) must go through `repos.resolve` as well.
 *
 * A POST runs to the end even if the client goes away, as git may be halfway through a write:
 * in a fiber of the server's scope, which shutting the server down (or git's own timeout)
 * still stops. With `lock`, it also runs one at a time per repo, so concurrent git commands
 * don't collide on .git/index.lock.
 */
const repoRoute = (
  method: ApiRoute["method"],
  path: `/${string}`,
  answer: (repo: string) => Answer,
  { lock = false }: { lock?: boolean } = {},
): ApiRoute =>
  route(method, `/api/repo${path}`, ({ repos, scope }) =>
    Effect.gen(function* () {
      const input = yield* searchParam("repo");
      if (!input) return yield* new HttpError({ status: 400, error: "Missing repo" });
      const repo = yield* repos.resolve(input);
      const work = lock ? withRepoLock(repo, answer(repo)) : answer(repo);
      if (method !== "POST") return yield* work;
      return yield* Fiber.join(yield* Effect.forkIn(work, scope));
    }),
  );

/** A POST under /api/repo that writes, under the repo's lock. */
const mutation = (path: `/${string}`, answer: (repo: string) => Answer) =>
  repoRoute("POST", path, answer, { lock: true });

/** A remote operation. Fetch and push leave the index alone, and may take long: no lock. */
const remote = (action: "fetch" | "pull" | "push") =>
  repoRoute(
    "POST",
    `/remote/${action}`,
    (repo) => Effect.map(g.remoteAction(repo, action), (output) => ({ ok: true, output })),
    { lock: action === "pull" },
  );

/**
 * Every method but HEAD, which the router sends to the GET route of the path when no route has
 * HEAD: a catch-all on HEAD would shadow every GET route.
 */
const ANY_BUT_HEAD = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const notFound = () => Effect.fail(new HttpError({ status: 404, error: "Not found" }));

const ok = { ok: true };

/** Every API route. Tests list them from here; `createApp` serves them. */
export const API_ROUTES: readonly ApiRoute[] = [
  route("GET", "/api/config", ({ opts, configDir }) =>
    Effect.gen(function* () {
      return {
        initialRepo: opts.initialRepo ?? null,
        recent: yield* readRecent(configDir),
        home: os.homedir(),
      };
    }),
  ),
  route("POST", "/api/open", ({ repos }) =>
    Effect.gen(function* () {
      const root = yield* repos.open((yield* body(OpenBody)).path);
      return { root, name: path.basename(root) };
    }),
  ),

  repoRoute("GET", "/status", g.status),
  repoRoute("GET", "/diff", (repo) =>
    Effect.gen(function* () {
      const file = yield* searchParam("path");
      if ((yield* searchParam("untracked")) === "1") {
        return yield* untrackedDiff(repo, yield* decode(WorkingPath, file));
      }
      return yield* g.fileDiff(repo, {
        path: yield* decode(FilePath(), file),
        origPath: (yield* searchParam("origPath")) || undefined,
        staged: (yield* searchParam("staged")) === "1",
      });
    }),
  ),
  mutation("/stage", (repo) =>
    Effect.as(
      Effect.flatMap(body(PathsBody), (b) => g.stage(repo, b.paths)),
      ok,
    ),
  ),
  mutation("/unstage", (repo) =>
    Effect.as(
      Effect.flatMap(body(PathsBody), (b) => g.unstage(repo, b.paths)),
      ok,
    ),
  ),
  mutation("/discard", (repo) =>
    Effect.as(
      Effect.flatMap(body(DiscardBody), (b) => g.discard(repo, b.file)),
      ok,
    ),
  ),
  mutation("/commit", (repo) =>
    Effect.gen(function* () {
      const { message, amend } = yield* body(CommitBody);
      if (!message.trim() && !amend) return yield* g.gitError("Commit message is empty");
      return { ok: true, output: yield* g.commit(repo, message, amend) };
    }),
  ),
  repoRoute("GET", "/last-message", (repo) =>
    Effect.map(g.lastCommitMessage(repo), (message) => ({ message })),
  ),
  repoRoute("GET", "/log", (repo) =>
    Effect.gen(function* () {
      const limit = Math.min(Number((yield* searchParam("limit")) ?? 300) || 300, 5000);
      const r = yield* searchParam("ref");
      const commits = yield* g.log(repo, {
        limit,
        all: (yield* searchParam("all")) === "1",
        ref: r ? yield* decode(Ref(), r) : undefined,
      });
      return { commits };
    }),
  ),
  repoRoute("GET", "/commit/:hash", (repo) =>
    Effect.gen(function* () {
      const { hash } = yield* HttpRouter.params;
      return yield* g.showCommit(repo, yield* decode(Ref("hash"), hash));
    }),
  ),
  repoRoute("GET", "/files", (repo) => workingFiles(repo)),
  repoRoute("GET", "/file", (repo) =>
    Effect.flatMap(
      Effect.flatMap(searchParam("path"), (p) => decode(WorkingPath, p)),
      (file) => workingFile(repo, file),
    ),
  ),
  repoRoute("GET", "/branches", (repo) =>
    Effect.map(g.branches(repo), (branches) => ({ branches })),
  ),
  mutation("/checkout", (repo) =>
    Effect.as(
      Effect.flatMap(body(CheckoutBody), (b) => g.checkout(repo, b.name, b.remote)),
      ok,
    ),
  ),
  mutation("/branch", (repo) =>
    Effect.as(
      Effect.flatMap(body(BranchBody), (b) =>
        g.createBranch(repo, b.name, b.from || undefined, b.checkout),
      ),
      ok,
    ),
  ),
  mutation("/branch/delete", (repo) =>
    Effect.as(
      Effect.flatMap(body(DeleteBranchBody), (b) => g.deleteBranch(repo, b.name, b.force)),
      ok,
    ),
  ),
  remote("fetch"),
  remote("pull"),
  remote("push"),
  // Unknown API routes (and /api itself) get a JSON 404; under /api/repo, only once past the
  // gate.
  ...ANY_BUT_HEAD.map((method) => repoRoute(method, "/*", notFound)),
  ...ANY_BUT_HEAD.map((method) => route(method, "/api/*", notFound)),
];

/**
 * How the router matches paths: exactly as written, as they did under Hono, so `/API/config`,
 * `//api/config` and `/api/config/` match no route. (The access middleware refuses what the
 * router would still rewrite: percent escapes and `;`.)
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
