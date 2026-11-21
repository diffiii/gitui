// The API, on Effect's HttpRouter: each route is an Effect that answers JSON. Request bodies and
// parameters are decoded with the schemas below, whose messages are the 400s' errors; a
// GitError is a 400, a RepoNotOpenedError a 403 with REPO_NOT_OPENED, and anything else a 500.
// createApp serves it as a web handler (`fetch`), which main.ts puts on a Node server and the
// nearby bridge calls directly.
import os from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { issueMessage, REPO_NOT_OPENED, withMessage } from "@gitui/shared";
import { Cause, Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type AccessOptions, access } from "./access.ts";
import { CONFIG_DIR, readRecent } from "./config.ts";
import { untrackedDiff, workingFile, workingFiles } from "./files.ts";
import * as g from "./git.ts";
import { withRepoLock } from "./lock.ts";
import { type RepoNotOpenedError, repoGate } from "./repo-scope.ts";

export interface AppOptions extends AccessOptions {
  initialRepo?: string;
  /** Where the recent list lives; tests pass a temp dir. */
  configDir?: string;
}

/** A response other than a route's own: a refusal before it ran, or no route at all. */
class HttpError extends Data.TaggedError("HttpError")<{ status: number; error: string }> {}

type AppError = g.GitError | RepoNotOpenedError | HttpError;

// ---------------------------------------------------------------- requests

/** A ref, branch or hash: anything git could parse as an option is refused. */
const Ref = (field = "ref") =>
  withMessage(
    Schema.String,
    `Invalid ${field}`,
    Schema.makeFilter((v: string) => v !== "" && !v.startsWith("-") && !/[\0\n]/.test(v), {
      message: `Invalid ${field}`,
    }),
  );

/** A single repo-relative path; may not be empty or contain NUL. */
const FilePath = (field = "path") =>
  withMessage(
    Schema.String,
    `Invalid ${field}`,
    Schema.makeFilter((v: string) => v !== "" && !v.includes("\0"), {
      message: `Invalid ${field}`,
    }),
  );

/** A path to read from the working copy: relative, never stepping up with `..`, and no folder. */
const WorkingPath = withMessage(
  FilePath(),
  "Invalid path",
  Schema.makeFilter(
    (p: string) => {
      const parts = p.split(/[/\\]/);
      return !path.isAbsolute(p) && !parts.includes("..") && !parts.includes("");
    },
    { message: "Invalid path" },
  ),
);

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

/** The request's JSON body, decoded with `schema`; malformed JSON is a client error too. */
const body = <S extends Schema.Decoder<unknown>>(schema: S) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((req) => req.json),
    Effect.mapError(() => g.gitError("Invalid JSON body")),
    Effect.flatMap((json) => decode(schema, json)),
  );

/** The request's query parameters. */
const query = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (req) => new URL(req.url, "http://gitui.invalid").searchParams,
);

/** The request's path. */
const pathname = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (req) => new URL(req.url, "http://gitui.invalid").pathname,
);

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

/** What a route may use: the request, its path parameters, and the Node services. */
type RouteServices =
  | HttpServerRequest.HttpServerRequest
  | HttpRouter.RouteContext
  | NodeServices.NodeServices;

/** An API route: what it answers, as an Effect that the router runs for each request. */
export interface ApiRoute {
  method: "GET" | "POST" | "*";
  path: string;
  handle: Effect.Effect<HttpServerResponse.HttpServerResponse, never, RouteServices>;
}

/** Long-running network operations that don't write the index skip the repo lock. */
const UNLOCKED_PATHS = /\/remote\/(fetch|push)$/;

export function createApp(opts: AppOptions, extraRoutes: ApiRoute[] = []) {
  const { middleware, repoScope } = access(opts);
  const configDir = opts.configDir ?? CONFIG_DIR;
  const repos = repoGate(repoScope, { initialRepo: opts.initialRepo, configDir });

  const route = (
    method: ApiRoute["method"],
    path: string,
    answer: Effect.Effect<unknown, AppError, RouteServices>,
  ): ApiRoute => ({ method, path, handle: respond(Effect.map(answer, (v) => json(v))) });

  /**
   * A route under /api/repo, on the repository in `?repo=`, through the gate. A repository path
   * that comes any other way (a body field) must go through `repos.resolve` as well. Mutations
   * run one at a time per repo, so concurrent git commands don't collide on .git/index.lock.
   */
  const repoRoute = (
    method: ApiRoute["method"],
    path: string,
    answer: (repo: string) => Effect.Effect<unknown, AppError, RouteServices>,
  ): ApiRoute =>
    route(
      method,
      `/api/repo${path}`,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const input = (yield* query).get("repo");
        if (!input) return yield* new HttpError({ status: 400, error: "Missing repo" });
        const repo = yield* repos.resolve(input);
        const locked = req.method !== "GET" && !UNLOCKED_PATHS.test(yield* pathname);
        return yield* locked ? withRepoLock(repo, answer(repo)) : answer(repo);
      }),
    );

  const ok = { ok: true };

  const routes: ApiRoute[] = [
    route(
      "GET",
      "/api/config",
      Effect.gen(function* () {
        return {
          initialRepo: opts.initialRepo ?? null,
          recent: yield* readRecent(configDir),
          home: os.homedir(),
        };
      }),
    ),
    route(
      "POST",
      "/api/open",
      Effect.gen(function* () {
        const root = yield* repos.open((yield* body(OpenBody)).path);
        return { root, name: path.basename(root) };
      }),
    ),

    repoRoute("GET", "/status", g.status),
    repoRoute("GET", "/diff", (repo) =>
      Effect.gen(function* () {
        const q = yield* query;
        if (q.get("untracked") === "1") {
          return yield* untrackedDiff(repo, yield* decode(WorkingPath, q.get("path") ?? undefined));
        }
        return yield* g.fileDiff(repo, {
          path: yield* decode(FilePath(), q.get("path") ?? undefined),
          origPath: q.get("origPath") || undefined,
          staged: q.get("staged") === "1",
        });
      }),
    ),
    repoRoute("POST", "/stage", (repo) =>
      Effect.as(
        Effect.flatMap(body(PathsBody), (b) => g.stage(repo, b.paths)),
        ok,
      ),
    ),
    repoRoute("POST", "/unstage", (repo) =>
      Effect.as(
        Effect.flatMap(body(PathsBody), (b) => g.unstage(repo, b.paths)),
        ok,
      ),
    ),
    repoRoute("POST", "/discard", (repo) =>
      Effect.as(
        Effect.flatMap(body(DiscardBody), (b) => g.discard(repo, b.file)),
        ok,
      ),
    ),
    repoRoute("POST", "/commit", (repo) =>
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
        const q = yield* query;
        const limit = Math.min(Number(q.get("limit") ?? 300) || 300, 5000);
        const r = q.get("ref");
        const commits = yield* g.log(repo, {
          limit,
          all: q.get("all") === "1",
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
    repoRoute("GET", "/files", workingFiles),
    repoRoute("GET", "/file", (repo) =>
      Effect.flatMap(
        Effect.flatMap(query, (q) => decode(WorkingPath, q.get("path") ?? undefined)),
        (file) => workingFile(repo, file),
      ),
    ),
    repoRoute("GET", "/branches", (repo) =>
      Effect.map(g.branches(repo), (branches) => ({ branches })),
    ),
    repoRoute("POST", "/checkout", (repo) =>
      Effect.as(
        Effect.flatMap(body(CheckoutBody), (b) => g.checkout(repo, b.name, b.remote)),
        ok,
      ),
    ),
    repoRoute("POST", "/branch", (repo) =>
      Effect.as(
        Effect.flatMap(body(BranchBody), (b) =>
          g.createBranch(repo, b.name, b.from || undefined, b.checkout),
        ),
        ok,
      ),
    ),
    repoRoute("POST", "/branch/delete", (repo) =>
      Effect.as(
        Effect.flatMap(body(DeleteBranchBody), (b) => g.deleteBranch(repo, b.name, b.force)),
        ok,
      ),
    ),
    repoRoute("POST", "/remote/:action", (repo) =>
      Effect.gen(function* () {
        const { action } = yield* HttpRouter.params;
        if (action !== "fetch" && action !== "pull" && action !== "push") {
          return yield* new HttpError({ status: 400, error: "Bad action" });
        }
        return { ok: true, output: yield* g.remoteAction(repo, action) };
      }),
    ),
    ...extraRoutes,
    // Unknown API routes (and /api itself) get a JSON 404; under /api/repo, only once past the
    // gate.
    repoRoute("*", "/*", () => Effect.fail(new HttpError({ status: 404, error: "Not found" }))),
    route("*", "/api/*", Effect.fail(new HttpError({ status: 404, error: "Not found" }))),
  ];

  const app = HttpRouter.addAll(
    routes.map((r) => HttpRouter.route(r.method, r.path as HttpRouter.PathInput, r.handle)),
  ).pipe(HttpRouter.provideRequest(NodeServices.layer), Layer.provide(middleware));
  const layer = Layer.mergeAll(app, middleware);
  const { handler, dispose } = HttpRouter.toWebHandler(layer, { disableLogger: true });
  const fetch = (request: Request): Promise<Response> => handler(request);
  return {
    /** The routes and middleware, for a server to serve (main.ts). */
    layer,
    /** The app as a web handler, as the nearby bridge and tests call it. */
    fetch,
    /** `fetch` for a URL or a path (on http://localhost), as tests send requests. */
    request: (input: string, init?: RequestInit) =>
      fetch(new Request(new URL(input, "http://localhost").href, init)),
    /** Every route, "METHOD /path", the catch-alls last. */
    routes: routes.map(({ method, path }) => ({ method: method === "*" ? "ALL" : method, path })),
    dispose,
  };
}

export type App = ReturnType<typeof createApp>;
