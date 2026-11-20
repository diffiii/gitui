import type { Branch, Commit, CommitDetail, FileStatus, Status } from "../../shared/types.ts";

export type { Branch, Commit, CommitDetail, FileStatus, Status };

export class ApiError extends Error {}

async function request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "x-gitui": "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText);
  return data as T;
}

export interface AppConfig {
  initialRepo: string | null;
  recent: string[];
  home: string;
}

export const getConfig = () => request<AppConfig>("GET", "/api/config");
export const openRepo = (path: string) =>
  request<{ root: string; name: string }>("POST", "/api/open", { path });

export function repoApi(repo: string) {
  const u = (p: string, params: Record<string, string | undefined> = {}) => {
    const sp = new URLSearchParams({ repo });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
    return `/api/repo${p}?${sp}`;
  };
  return {
    status: () => request<Status>("GET", u("/status")),
    diff: (f: { path: string; origPath?: string; staged: boolean; untracked?: boolean }) =>
      request<{ diff: string; truncated: boolean }>(
        "GET",
        u("/diff", {
          path: f.path,
          origPath: f.origPath,
          staged: f.staged ? "1" : "0",
          untracked: f.untracked ? "1" : "0",
        }),
      ),
    stage: (paths?: string[]) => request("POST", u("/stage"), { paths }),
    unstage: (paths?: string[]) => request("POST", u("/unstage"), { paths }),
    discard: (file: FileStatus) => request("POST", u("/discard"), { file }),
    commit: (message: string, amend: boolean) =>
      request<{ output: string }>("POST", u("/commit"), { message, amend }),
    lastMessage: () => request<{ message: string }>("GET", u("/last-message")),
    log: (opts: { limit: number; all: boolean; ref?: string }) =>
      request<{ commits: Commit[] }>(
        "GET",
        u("/log", { limit: String(opts.limit), all: opts.all ? "1" : "0", ref: opts.ref }),
      ),
    showCommit: (hash: string) =>
      request<CommitDetail>("GET", u(`/commit/${encodeURIComponent(hash)}`)),
    branches: () => request<{ branches: Branch[] }>("GET", u("/branches")),
    checkout: (name: string, remote: boolean) => request("POST", u("/checkout"), { name, remote }),
    createBranch: (name: string, from?: string) => request("POST", u("/branch"), { name, from }),
    deleteBranch: (name: string, force: boolean) =>
      request("POST", u("/branch/delete"), { name, force }),
    remote: (action: "fetch" | "pull" | "push") =>
      request<{ output: string }>("POST", u(`/remote/${action}`)),
  };
}

export type RepoApi = ReturnType<typeof repoApi>;
