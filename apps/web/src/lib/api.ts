// The web client of the API, built from its contract (@gitui/shared's api.ts): `call` sends an
// endpoint's method to its path with the inputs the contract gives it, and answers with what the
// contract says it responds. That isn't checked at runtime: the server produces it, and the type
// check ties both sides to the contract.
import type {
  ApiKey,
  ApiRequest,
  AppConfig,
  Branch,
  Commit,
  CommitDetail,
  FileStatus,
  RemoteAction,
  ResponseOf,
  Status,
  WorkingFile,
  WorkingFiles,
} from "@gitui/shared";
import { API, apiUrl, REPO_NOT_OPENED } from "@gitui/shared";
import { ApiError, apiTransport, getConnection, rejectConnection } from "./connection.ts";

export type {
  AppConfig,
  Branch,
  Commit,
  CommitDetail,
  FileStatus,
  Status,
  WorkingFile,
  WorkingFiles,
};

/** What a query passes its queryFn; its signal cancels the request. */
export interface Cancel {
  signal?: AbortSignal;
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  { body, signal }: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const connection = getConnection();
  const send = apiTransport(connection);
  const res = await send(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  }).catch(() => {
    if (signal?.aborted) throw signal.reason;
    throw new ApiError("Can't reach gitui", "unreachable");
  });
  let isJson = true;
  const data = await res.json().catch(() => {
    isJson = false;
    return { error: res.statusText };
  });
  if (res.status === 401) {
    rejectConnection(connection);
    throw new ApiError(data.error ?? res.statusText, "unauthorized");
  }
  if (res.status === 403 && data.code === REPO_NOT_OPENED) {
    throw new ApiError(data.error, "not-opened");
  }
  // The API's catch-all answers unknown routes with a JSON 404 and nothing else does with JSON
  // (the access checks' 404 for oddly spelled paths is plain text): the CLI is older than this page.
  if (res.status === 404 && isJson) {
    throw new ApiError(
      "This needs a newer gitui: run the latest (npx @diffiii/gitui@latest) or update your install, then restart it.",
      "http",
    );
  }
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, "http");
  return data as T;
}

/** Everything `call` sends to an endpoint: what the contract has it take, and its signal. */
export type CallOptions<K extends ApiKey> = ApiRequest<K> & Cancel;

/**
 * A request to `key` (spelled by the contract's `apiUrl`), answered with the endpoint's response.
 * Its body is sent as JSON when there is one (an endpoint without a body in the contract gets
 * none).
 */
export function call<K extends ApiKey>(key: K, options: CallOptions<K>): Promise<ResponseOf<K>> {
  return request<ResponseOf<K>>(API[key].method, apiUrl(key, options), options);
}

export const getConfig = (c?: Cancel) => call("config", { signal: c?.signal });
export const openRepo = (path: string) => call("open", { body: { path } });

export function repoApi(repo: string) {
  // Reads take the query's Cancel last, so `queryFn: api.status` passes it straight through.
  return {
    status: (c?: Cancel) => call("status", { repo, signal: c?.signal }),
    diff: (
      f: { path: string; origPath?: string; staged: boolean; untracked?: boolean },
      c?: Cancel,
    ) =>
      call("diff", {
        repo,
        query: { path: f.path, origPath: f.origPath, staged: f.staged, untracked: !!f.untracked },
        signal: c?.signal,
      }),
    stage: (paths?: string[]) => call("stage", { repo, body: { paths } }),
    unstage: (paths?: string[]) => call("unstage", { repo, body: { paths } }),
    discard: (file: FileStatus) => call("discard", { repo, body: { file } }),
    commit: (message: string, amend: boolean) => call("commit", { repo, body: { message, amend } }),
    lastMessage: (c?: Cancel) => call("lastMessage", { repo, signal: c?.signal }),
    log: (opts: { limit: number; all: boolean; ref?: string }, c?: Cancel) =>
      call("log", {
        repo,
        query: { limit: opts.limit, all: opts.all, ref: opts.ref },
        signal: c?.signal,
      }),
    showCommit: (hash: string, c?: Cancel) =>
      call("showCommit", { repo, params: { hash }, signal: c?.signal }),
    files: (c?: Cancel) => call("files", { repo, signal: c?.signal }),
    file: (path: string, c?: Cancel) => call("file", { repo, query: { path }, signal: c?.signal }),
    branches: (c?: Cancel) => call("branches", { repo, signal: c?.signal }),
    checkout: (name: string, remote: boolean) => call("checkout", { repo, body: { name, remote } }),
    createBranch: (name: string, from?: string) =>
      call("createBranch", { repo, body: { name, from } }),
    deleteBranch: (name: string, force: boolean) =>
      call("deleteBranch", { repo, body: { name, force } }),
    remote: (action: RemoteAction) => call(action, { repo }),
  };
}

export type RepoApi = ReturnType<typeof repoApi>;
