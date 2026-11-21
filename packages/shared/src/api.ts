// The HTTP API between the CLI and the web app, declared once: each endpoint's method and path
// (API), and what it takes and answers (ApiTypes). The server's route table (apps/cli/server/
// app.ts) must serve exactly these, with schemas and answers that match, and the web client
// (apps/web/src/lib/api.ts) is built from them, so a mismatch fails the type check. Plain
// types: the web's main chunk carries no Effect, and responses aren't validated at runtime there
// (the server produces them, and the type check ties both sides together).
// `query` is what the client passes before encoding (booleans travel as "1"/"0", numbers as
// decimal strings, absent keys are left out); `body` is the JSON as sent.
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

export const API = {
  config: { method: "GET", path: "/api/config" },
  open: { method: "POST", path: "/api/open" },
  status: { method: "GET", path: "/api/repo/status" },
  diff: { method: "GET", path: "/api/repo/diff" },
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
} as const satisfies Record<string, { method: "GET" | "POST"; path: `/api/${string}` }>;

export type ApiKey = keyof typeof API;
/** The endpoints under /api/repo, which name their repository in `?repo=`. */
export type RepoApiKey = {
  [K in ApiKey]: (typeof API)[K]["path"] extends `/api/repo/${string}` ? K : never;
}[ApiKey];

export interface Ok {
  ok: true;
}
export interface OkOutput {
  ok: true;
  output: string;
}

export interface ApiTypes {
  config: { response: AppConfig };
  open: { body: { path: string }; response: { root: string; name: string } };
  status: { response: Status };
  diff: {
    query: { path: string; origPath?: string; staged: boolean; untracked: boolean };
    response: { diff: string; truncated: boolean };
  };
  stage: { body: { paths?: string[] }; response: Ok };
  unstage: { body: { paths?: string[] }; response: Ok };
  discard: { body: { file: DiscardFile }; response: Ok };
  commit: { body: { message: string; amend?: boolean }; response: OkOutput };
  lastMessage: { response: { message: string } };
  log: {
    query: { limit: number; all: boolean; ref?: string };
    response: { commits: Commit[] };
  };
  showCommit: { params: { hash: string }; response: CommitDetail };
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

/** The file a discard names, as the web sends it (a FileStatus; the server reads only `path`). */
export type DiscardFile = Pick<FileStatus, "path" | "origPath" | "untracked" | "conflicted"> & {
  x?: string;
  y?: string;
};

// Helpers: what each endpoint takes and answers (never, where it takes none).
export type QueryOf<K extends ApiKey> = ApiTypes[K] extends { query: infer Q } ? Q : never;
export type BodyOf<K extends ApiKey> = ApiTypes[K] extends { body: infer B } ? B : never;
export type ParamsOf<K extends ApiKey> = ApiTypes[K] extends { params: infer P } ? P : never;
export type ResponseOf<K extends ApiKey> = ApiTypes[K]["response"];
