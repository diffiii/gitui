import type {
  Branch,
  Commit,
  CommitDetail,
  FileStatus,
  Status,
  WorkingFile,
  WorkingFiles,
} from "@gitui/shared";
import { REPO_NOT_OPENED } from "@gitui/shared";
import { ApiError, apiTransport, getConnection, rejectConnection } from "./connection.ts";
import { ChannelRequestError } from "./nearby/channelFetch.ts";

export type { Branch, Commit, CommitDetail, FileStatus, Status, WorkingFile, WorkingFiles };

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
  }).catch((e: unknown) => {
    if (signal?.aborted) throw signal.reason;
    // The host answered, but not with a response this page takes (e.g. one too large).
    if (e instanceof ChannelRequestError) throw new ApiError(e.message, "http");
    throw new ApiError("Can't reach gitui", "unreachable");
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (res.status === 401) {
    rejectConnection(connection);
    throw new ApiError(data.error ?? res.statusText, "unauthorized");
  }
  if (res.status === 403 && data.code === REPO_NOT_OPENED) {
    throw new ApiError(data.error, "not-opened");
  }
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, "http");
  return data as T;
}

const get = <T>(path: string, { signal }: Cancel = {}) => request<T>("GET", path, { signal });
const post = <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, { body });

export interface AppConfig {
  initialRepo: string | null;
  recent: string[];
  home: string;
}

export const getConfig = (c?: Cancel) => get<AppConfig>("/api/config", c);
export const openRepo = (path: string) =>
  post<{ root: string; name: string }>("/api/open", { path });

export function repoApi(repo: string) {
  const u = (p: string, params: Record<string, string | undefined> = {}) => {
    const sp = new URLSearchParams({ repo });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
    return `/api/repo${p}?${sp}`;
  };
  // Reads take the query's Cancel last, so `queryFn: api.status` passes it straight through.
  return {
    status: (c?: Cancel) => get<Status>(u("/status"), c),
    diff: (
      f: { path: string; origPath?: string; staged: boolean; untracked?: boolean },
      c?: Cancel,
    ) =>
      get<{ diff: string; truncated: boolean }>(
        u("/diff", {
          path: f.path,
          origPath: f.origPath,
          staged: f.staged ? "1" : "0",
          untracked: f.untracked ? "1" : "0",
        }),
        c,
      ),
    stage: (paths?: string[]) => post(u("/stage"), { paths }),
    unstage: (paths?: string[]) => post(u("/unstage"), { paths }),
    discard: (file: FileStatus) => post(u("/discard"), { file }),
    commit: (message: string, amend: boolean) =>
      post<{ output: string }>(u("/commit"), { message, amend }),
    lastMessage: (c?: Cancel) => get<{ message: string }>(u("/last-message"), c),
    log: (opts: { limit: number; all: boolean; ref?: string }, c?: Cancel) =>
      get<{ commits: Commit[] }>(
        u("/log", { limit: String(opts.limit), all: opts.all ? "1" : "0", ref: opts.ref }),
        c,
      ),
    showCommit: (hash: string, c?: Cancel) =>
      get<CommitDetail>(u(`/commit/${encodeURIComponent(hash)}`), c),
    files: (c?: Cancel) => get<WorkingFiles>(u("/files"), c),
    file: (path: string, c?: Cancel) => get<WorkingFile>(u("/file", { path }), c),
    branches: (c?: Cancel) => get<{ branches: Branch[] }>(u("/branches"), c),
    checkout: (name: string, remote: boolean) => post(u("/checkout"), { name, remote }),
    createBranch: (name: string, from?: string) => post(u("/branch"), { name, from }),
    deleteBranch: (name: string, force: boolean) => post(u("/branch/delete"), { name, force }),
    remote: (action: "fetch" | "pull" | "push") => post<{ output: string }>(u(`/remote/${action}`)),
  };
}

export type RepoApi = ReturnType<typeof repoApi>;
