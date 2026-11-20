// Types shared between the server and the browser app.

export interface HeadInfo {
  branch: string | null; // null when detached
  oid: string | null; // null on unborn branch
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface FileStatus {
  path: string;
  origPath?: string;
  /** Index (staged) status char, "." when unchanged. */
  x: string;
  /** Worktree status char, "." when unchanged. */
  y: string;
  untracked?: boolean;
  conflicted?: boolean;
}

export interface Status {
  head: HeadInfo;
  files: FileStatus[];
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  refs: string[];
  subject: string;
}

export interface CommitDetail extends Commit {
  committer: string;
  committerDate: number;
  body: string;
  patch: string;
  /** The patch exceeded the server's output cap and was cut short. */
  truncated: boolean;
}

export interface Branch {
  name: string;
  ref: string;
  remote: boolean;
  hash: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  date: number;
  subject: string;
  current: boolean;
}

/** The working copy's files: tracked ones still on disk, and untracked ones that aren't ignored. */
export interface WorkingFiles {
  paths: string[];
  /** The repo has more files than the server lists; `paths` holds the first of them. */
  truncated: boolean;
}

/**
 * One working-copy file as it is on disk. `size` is in bytes. A symbolic link isn't followed: its
 * `content` is the link's target.
 */
export type WorkingFile =
  | { size: number; content: string; symlink?: true }
  | { size: number; binary: true }
  | { size: number; tooLarge: true };
