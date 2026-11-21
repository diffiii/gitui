// The HTTP API between the CLI and the web app, declared once: each endpoint's method and path
// (API), what it takes and answers (ApiTypes), and how a request to it is spelled (apiUrl). The
// server's route table (apps/cli/server/app.ts) must serve exactly these, with schemas and
// answers that match, and the web client (apps/web/src/lib/api.ts) is built from them, so a
// mismatch fails the type check. Plain types: the web's main chunk carries no Effect, and
// responses aren't validated at runtime there (the server produces them, and the type check ties
// both sides together).
// `query` is what the client passes before encoding (booleans travel as "1"/"0", numbers as
// decimal strings, absent keys are left out); `body` is the JSON as sent. Path parameters
// (`:name`) come from the path itself.
import type {
  AppConfig,
  Branch,
  Commit,
  CommitDetail,
  FileStatus,
  Status,
  WorkingFile,
  WorkingFiles,
} from "./types.ts";
import type { LinesAction, LineSelection } from "./lines.ts";

export interface Ok {
  ok: true;
}
export interface OkOutput {
  ok: true;
  output: string;
}

/** The file a discard names, as the web sends it (a FileStatus; the server reads only `path`). */
export type DiscardFile = Pick<FileStatus, "path" | "origPath" | "untracked" | "conflicted"> & {
  x?: string;
  y?: string;
};

/**
 * An `applyLines` request: which lines of which file's diff, and what to do with them. The side
 * follows from the action (`unstage` takes the staged diff), and a rename's other path from git's
 * status.
 */
export interface LinesRequest {
  path: string;
  action: LinesAction;
  /** The `base` of the diff the lines were picked from. */
  base: string;
  lines: LineSelection;
}

export interface ApiTypes {
  config: { response: AppConfig };
  open: { body: { path: string }; response: { root: string; name: string } };
  status: { response: Status };
  diff: {
    query: { path: string; origPath?: string; staged: boolean; untracked: boolean };
    /**
     * `base` identifies the diff for `applyLines`: sent for a tracked file's whole diff, never
     * for an untracked or truncated one. A CLI older than line staging sends none.
     */
    response: { diff: string; truncated: boolean; base?: string };
  };
  /**
   * Stages (`stage`, from the unstaged diff), unstages (`unstage`, from the staged one) or
   * discards (`discard`, from the unstaged one) some of a file's changed lines: `deletions` are
   * old-side numbers of `-` lines and `additions` new-side numbers of `+` lines, in the diff
   * whose `base` the client was shown. The server builds the patch itself; a selection of every
   * changed line stages, unstages or discards the whole file instead.
   */
  applyLines: { body: LinesRequest; response: Ok };
  stage: { body: { paths?: string[] }; response: Ok };
  unstage: { body: { paths?: string[] }; response: Ok };
  discard: { body: { file: DiscardFile }; response: Ok };
  commit: { body: { message: string; amend?: boolean }; response: OkOutput };
  lastMessage: { response: { message: string } };
  log: {
    query: { limit: number; all: boolean; ref?: string };
    response: { commits: Commit[] };
  };
  showCommit: { response: CommitDetail };
  files: { response: WorkingFiles };
  file: { query: { path: string }; response: WorkingFile };
  branches: { response: { branches: Branch[] } };
  checkout: { body: { name: string; remote?: boolean }; response: Ok };
  createBranch: { body: { name: string; from?: string; checkout?: boolean }; response: Ok };
  deleteBranch: { body: { name: string; force?: boolean }; response: Ok };
  fetch: { response: OkOutput };
  pull: { response: OkOutput };
  push: { response: OkOutput };
}

// Keyed by ApiTypes, so an endpoint in one and not the other fails here, either way round.
export const API = {
  config: { method: "GET", path: "/api/config" },
  open: { method: "POST", path: "/api/open" },
  status: { method: "GET", path: "/api/repo/status" },
  diff: { method: "GET", path: "/api/repo/diff" },
  applyLines: { method: "POST", path: "/api/repo/apply-lines" },
  stage: { method: "POST", path: "/api/repo/stage" },
  unstage: { method: "POST", path: "/api/repo/unstage" },
  discard: { method: "POST", path: "/api/repo/discard" },
  commit: { method: "POST", path: "/api/repo/commit" },
  lastMessage: { method: "GET", path: "/api/repo/last-message" },
  log: { method: "GET", path: "/api/repo/log" },
  showCommit: { method: "GET", path: "/api/repo/commit/:hash" },
  files: { method: "GET", path: "/api/repo/files" },
  file: { method: "GET", path: "/api/repo/file" },
  branches: { method: "GET", path: "/api/repo/branches" },
  checkout: { method: "POST", path: "/api/repo/checkout" },
  createBranch: { method: "POST", path: "/api/repo/branch" },
  deleteBranch: { method: "POST", path: "/api/repo/branch/delete" },
  fetch: { method: "POST", path: "/api/repo/remote/fetch" },
  pull: { method: "POST", path: "/api/repo/remote/pull" },
  push: { method: "POST", path: "/api/repo/remote/push" },
} as const satisfies {
  [K in keyof ApiTypes]: { method: "GET" | "POST"; path: `/api/${string}` };
};

export type ApiKey = keyof typeof API;
/** The endpoints under /api/repo, which name their repository in `?repo=`. */
export type RepoApiKey = {
  [K in ApiKey]: (typeof API)[K]["path"] extends `/api/repo/${string}` ? K : never;
}[ApiKey];
/** The remote operations, one endpoint each. */
export type RemoteAction = Extract<ApiKey, "fetch" | "pull" | "push">;

/** The names of a path's `:name` parameters. */
type ParamName<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamName<Rest>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
/** A path's `:name` parameters, each a string. */
export type PathParams<P extends string> = { [N in ParamName<P>]: string };
/** The path parameters of the endpoint `K`. */
export type ParamsOf<K extends ApiKey> = PathParams<(typeof API)[K]["path"]>;
export type ResponseOf<K extends ApiKey> = ApiTypes[K]["response"];

/**
 * What a request to `K` takes: its query and body as the contract has them, its repository for
 * one under /api/repo, and its path parameters for one whose path has some.
 */
export type ApiRequest<K extends ApiKey> = Omit<ApiTypes[K], "response"> &
  (K extends RepoApiKey ? { repo: string } : { repo?: never }) &
  ([keyof ParamsOf<K>] extends [never] ? { params?: never } : { params: ParamsOf<K> });

/** Every endpoint's request, loosely, as `apiUrl` reads it. */
interface AnyRequest {
  repo?: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * The path and query string of a request to `key`: its `:name` path parameters filled in
 * (escaped), then `repo` first and the query's own keys in their order, booleans as "1"/"0",
 * numbers as decimal strings, and `undefined` left out.
 */
export function apiUrl<K extends ApiKey>(key: K, request: Omit<ApiRequest<K>, "body">): string {
  const { repo, params = {}, query = {} } = request as AnyRequest;
  const path = API[key].path.replace(/:(\w+)/g, (_, name: string) =>
    encodeURIComponent(params[name]!),
  );
  const sp = new URLSearchParams(repo === undefined ? {} : { repo });
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) sp.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const search = sp.toString();
  return search ? `${path}?${search}` : path;
}
