import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  HeadInfo,
  FileStatus,
  Status,
  Commit,
  CommitDetail,
  Branch,
} from "../shared/types.ts";

export type { HeadInfo, FileStatus, Status, Commit, CommitDetail, Branch };

export class GitError extends Error {
  constructor(
    message: string,
    public code: number | null,
    public stderr: string,
  ) {
    super(message);
  }
}

interface RunOptions {
  /** Exit codes that should not throw (e.g. `git diff --no-index` exits 1 on differences). */
  okCodes?: number[];
  input?: string;
  maxBytes?: number;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

export function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const okCodes = opts.okCodes ?? [0];
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "core.quotepath=false", "-c", "color.ui=false", "--no-pager", ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        out.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      if (truncated) return resolve(stdout);
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== null && okCodes.includes(code)) return resolve(stdout);
      reject(new GitError(stderr || `git ${args[0]} exited with ${code}`, code, stderr));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export function expandHome(p: string) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolves any path inside a repository to the repository's top-level directory. */
export async function resolveRepo(input: string): Promise<string> {
  const dir = path.resolve(expandHome(input));
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new GitError(`Not a directory: ${dir}`, null, "");
  const top = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new GitError(`Not a git repository: ${dir}`, null, "");
  });
  return top.trim();
}

// ---------------------------------------------------------------- status

export async function status(repo: string): Promise<Status> {
  const raw = await git(repo, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  const head: HeadInfo = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0 };
  const files: FileStatus[] = [];
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("# ")) {
      const [, key, ...rest] = t.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") head.oid = val === "(initial)" ? null : val;
      else if (key === "branch.head") head.branch = val === "(detached)" ? null : val;
      else if (key === "branch.upstream") head.upstream = val;
      else if (key === "branch.ab") {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) {
          head.ahead = Number(m[1]);
          head.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = t[0];
    if (kind === "1") {
      const parts = t.split(" ");
      files.push({ x: parts[1][0], y: parts[1][1], path: parts.slice(8).join(" ") });
    } else if (kind === "2") {
      const parts = t.split(" ");
      files.push({
        x: parts[1][0],
        y: parts[1][1],
        path: parts.slice(9).join(" "),
        origPath: tokens[++i],
      });
    } else if (kind === "u") {
      const parts = t.split(" ");
      files.push({
        x: parts[1][0],
        y: parts[1][1],
        path: parts.slice(10).join(" "),
        conflicted: true,
      });
    } else if (kind === "?") {
      files.push({ x: ".", y: "?", path: t.slice(2), untracked: true });
    }
  }
  return { head, files, operation: await detectOperation(repo) };
}

async function detectOperation(repo: string): Promise<Status["operation"]> {
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  const exists = (p: string) =>
    stat(path.join(gitDir, p)).then(
      () => true,
      () => false,
    );
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) return "rebase";
  if (await exists("MERGE_HEAD")) return "merge";
  if (await exists("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await exists("REVERT_HEAD")) return "revert";
  return null;
}

async function hasHead(repo: string) {
  return git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------- diff

export async function fileDiff(
  repo: string,
  opts: { path: string; origPath?: string; staged: boolean; untracked: boolean },
): Promise<string> {
  if (opts.untracked) {
    return git(repo, ["diff", "--no-index", "--no-color", "--", "/dev/null", opts.path], {
      okCodes: [0, 1],
    });
  }
  const paths = opts.origPath ? [opts.origPath, opts.path] : [opts.path];
  const args = ["diff", "--no-color", "-M", "--no-ext-diff"];
  if (opts.staged) args.push("--cached");
  return git(repo, [...args, "--", ...paths]);
}

// ---------------------------------------------------------------- staging & commit

export async function stage(repo: string, paths?: string[]) {
  if (!paths) await git(repo, ["add", "-A"]);
  else await git(repo, ["add", "-A", "--", ...paths]);
}

export async function unstage(repo: string, paths?: string[]) {
  if (await hasHead(repo)) {
    if (!paths) await git(repo, ["reset", "-q"]);
    else await git(repo, ["restore", "--staged", "--", ...paths]);
  } else {
    await git(repo, ["rm", "--cached", "-r", "-q", "--", ...(paths ?? ["."])]);
  }
}

export async function discard(repo: string, file: FileStatus) {
  if (file.untracked) {
    await git(repo, ["clean", "-f", "-q", "--", file.path]);
  } else {
    await git(repo, ["restore", "--worktree", "--", file.path]);
  }
}

export async function commit(repo: string, message: string, amend: boolean) {
  const args = ["commit", "-F", "-"];
  if (amend) args.push("--amend");
  if (amend && !message.trim()) args.splice(1, 2, "--no-edit");
  return git(repo, args, { input: message });
}

export async function lastCommitMessage(repo: string) {
  if (!(await hasHead(repo))) return "";
  return git(repo, ["log", "-1", "--format=%B"]);
}

// ---------------------------------------------------------------- log

const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%D", "%s"].join("%x1f") + "%x1e";

function parseLog(raw: string): Commit[] {
  return raw
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, author, email, date, refs, subject] = r.split("\x1f");
      return {
        hash,
        parents: parents ? parents.split(" ") : [],
        author,
        email,
        date: Number(date),
        refs: refs ? refs.split(", ").filter(Boolean) : [],
        subject,
      };
    });
}

export async function log(
  repo: string,
  opts: { limit: number; all: boolean; ref?: string },
): Promise<Commit[]> {
  if (!(await hasHead(repo)) && !opts.all) return [];
  const args = [
    "log",
    "--topo-order",
    "--decorate=full",
    `-n${opts.limit}`,
    `--format=${LOG_FORMAT}`,
  ];
  if (opts.ref) args.push(opts.ref, "--");
  // Not --all: that would include tool-internal refs (refs/t3/*, refs/codex/*, refs/original/*, stash).
  else if (opts.all) args.push("--branches", "--remotes", "--tags", "HEAD");
  return parseLog(await git(repo, args).catch(() => ""));
}

export async function showCommit(repo: string, hash: string): Promise<CommitDetail> {
  const metaRaw = await git(repo, [
    "show",
    "-s",
    "--decorate=full",
    `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%cn%x1f%ct%x1f%b`,
    hash,
    "--",
  ]);
  const [h, parents, author, email, date, refs, subject, committer, cdate, body] =
    metaRaw.split("\x1f");
  const patch = await git(repo, [
    "show",
    "--format=",
    "--no-color",
    "-M",
    "--diff-merges=first-parent",
    "--no-ext-diff",
    hash,
    "--",
  ]);
  return {
    hash: h,
    parents: parents ? parents.split(" ") : [],
    author,
    email,
    date: Number(date),
    refs: refs ? refs.split(", ").filter(Boolean) : [],
    subject,
    committer,
    committerDate: Number(cdate),
    body: (body ?? "").trim(),
    patch,
  };
}

// ---------------------------------------------------------------- branches

export async function branches(repo: string): Promise<Branch[]> {
  const fmt = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname:short)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(committerdate:unix)",
    "%(subject)",
    "%(HEAD)",
  ].join("%1f");
  const raw = await git(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    `--format=${fmt}`,
    "refs/heads",
    "refs/remotes",
  ]);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, name, hash, upstream, track, date, subject, head] = line.split("\x1f");
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      return {
        ref,
        name,
        hash,
        remote: ref.startsWith("refs/remotes/"),
        upstream: upstream || null,
        ahead: ahead ? Number(ahead[1]) : 0,
        behind: behind ? Number(behind[1]) : 0,
        gone: track.includes("gone"),
        date: Number(date),
        subject,
        current: head === "*",
      };
    })
    .filter((b) => !(b.remote && b.ref.endsWith("/HEAD")));
}

export async function checkout(repo: string, name: string, remote: boolean) {
  if (remote) {
    // origin/feature -> create/switch local "feature" tracking it
    const local = name.split("/").slice(1).join("/");
    const exists = await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${local}`]).then(
      () => true,
      () => false,
    );
    if (exists) return git(repo, ["switch", local]);
    return git(repo, ["switch", "-c", local, "--track", name]);
  }
  return git(repo, ["switch", name]);
}

export async function createBranch(repo: string, name: string, from?: string, doCheckout = true) {
  if (doCheckout) return git(repo, ["switch", "-c", name, ...(from ? [from] : [])]);
  return git(repo, ["branch", name, ...(from ? [from] : [])]);
}

export async function deleteBranch(repo: string, name: string, force: boolean) {
  return git(repo, ["branch", force ? "-D" : "-d", name]);
}

// ---------------------------------------------------------------- remotes

export async function remoteAction(repo: string, action: "fetch" | "pull" | "push") {
  if (action === "fetch") return git(repo, ["fetch", "--all", "--prune"]);
  if (action === "pull") return git(repo, ["pull", "--ff-only"]);
  const st = await status(repo);
  if (!st.head.upstream) {
    const remotes = (await git(repo, ["remote"])).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new GitError("No remote configured", null, "");
    return git(repo, ["push", "-u", remote, "HEAD"]);
  }
  return git(repo, ["push"]);
}
