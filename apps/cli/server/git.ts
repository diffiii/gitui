// Git, run through Effect's ChildProcessSpawner (NodeServices provides it): every function
// here is an Effect that fails with a GitError when git does, or when the request makes no
// sense. Failures to run git at all (no `git` on PATH) are defects.
import os from "node:os";
import path from "node:path";
import type { HeadInfo, FileStatus, Status, Commit, CommitDetail, Branch } from "@gitui/shared";
import { Effect, Fiber, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export type { HeadInfo, FileStatus, Status, Commit, CommitDetail, Branch };

/** Git failed (`code` is its exit code, if it ran), or a request it was given makes no sense. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
  code: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
}) {}

/** A GitError that isn't git's own: a bad request, a missing remote. */
export const gitError = (message: string) => new GitError({ message, code: null, stderr: "" });

/** What git's functions need: a process spawner, and a file system for a few checks. */
export type GitServices = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

interface RunOptions {
  /** Exit codes that should not fail (e.g. `git diff --no-index` exits 1 on differences). */
  okCodes?: number[];
  input?: string;
  maxBytes?: number;
  /** Kill git and fail if it runs longer than this. Default: no timeout. */
  timeoutMs?: number;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** How long git and what it started get after a SIGTERM before a SIGKILL. */
const FORCE_KILL_AFTER = "2 seconds";

const text = (chunks: Uint8Array[]) => Buffer.concat(chunks).toString("utf8");

/** Run git; stdout past `maxBytes` (default 8 MB) is silently dropped. */
export const git = (
  cwd: string,
  args: string[],
  opts: RunOptions = {},
): Effect.Effect<string, GitError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.map(run(cwd, args, opts), (r) => r.stdout);

/**
 * Run a git command that prints a patch. If the patch exceeds `maxBytes`, it is cut back so it
 * still parses: to the last complete file if more than one survived, else to the last complete
 * line (the diff parser accepts the shortened final hunk). Content lines start with ' ', '+', '-'
 * or '\\', so "\ndiff --git " only matches real file headers.
 */
export const gitPatch = (
  cwd: string,
  args: string[],
  opts: RunOptions = {},
): Effect.Effect<
  { patch: string; truncated: boolean },
  GitError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.map(run(cwd, args, opts), ({ stdout, truncated }) => {
    if (!truncated) return { patch: stdout, truncated };
    const fileCut = stdout.lastIndexOf("\ndiff --git ");
    return {
      patch: stdout.slice(0, (fileCut >= 0 ? fileCut : stdout.lastIndexOf("\n")) + 1),
      truncated,
    };
  });

/**
 * Like `git()`, but says whether stdout was cut at `maxBytes` rather than dropping it silently.
 * Git runs in a process group of its own, which is ended (SIGTERM, then SIGKILL after
 * FORCE_KILL_AFTER) when its output is cut, when it times out, or when the caller is
 * interrupted, so what git started for itself (ssh, remote helpers) ends with it.
 */
export const run = (
  cwd: string,
  args: string[],
  opts: RunOptions = {},
): Effect.Effect<
  { stdout: string; truncated: boolean },
  GitError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  const { okCodes = [0], maxBytes = MAX_OUTPUT, timeoutMs } = opts;
  const command = ChildProcess.make(
    "git",
    ["-c", "core.quotepath=false", "-c", "color.ui=false", "--no-pager", ...args],
    {
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      extendEnv: true,
      stdin:
        opts.input === undefined
          ? "ignore"
          : { stream: Stream.make(new TextEncoder().encode(opts.input)) },
      forceKillAfter: FORCE_KILL_AFTER,
    },
  );
  const program = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(command);
    // Read stderr alongside stdout, so git never blocks on a full pipe; ending the scope (the
    // output was cut) interrupts it.
    const stderr = yield* Effect.forkScoped(
      Stream.runCollect(handle.stderr).pipe(Effect.map(text)),
    );
    const out: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    yield* Stream.runForEachWhile(handle.stdout, (chunk) =>
      Effect.sync(() => {
        size += chunk.length;
        if (size <= maxBytes) {
          out.push(chunk);
          return true;
        }
        truncated = true;
        out.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
        return false;
      }),
    );
    const stdout = text(out);
    if (truncated) return { stdout, truncated };
    const errText = (yield* Fiber.join(stderr)).trim();
    const code: number = yield* handle.exitCode;
    if (okCodes.includes(code)) return { stdout, truncated };
    return yield* new GitError({
      message: errText || `git ${args[0]} exited with ${code}`,
      code,
      stderr: errText,
    });
  }).pipe(
    Effect.scoped,
    // Not being able to run git at all isn't a git failure.
    Effect.catchTag("PlatformError", (e) => Effect.die(e)),
  );
  if (timeoutMs === undefined) return program;
  return program.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(gitError(`git ${args[0]} timed out after ${timeoutMs / 1000} s`)),
    }),
  );
};

export function expandHome(p: string) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Whether `p` exists; errors reading it count as no. */
const exists = (p: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(p)).pipe(
    Effect.orElseSucceed(() => false),
  );

/** Resolves any path inside a repository to the repository's top-level directory. */
export const resolveRepo = Effect.fnUntraced(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = path.resolve(expandHome(input));
  const info = yield* fs.stat(dir).pipe(Effect.option);
  if (info._tag === "None" || info.value.type !== "Directory") {
    return yield* gitError(`Not a directory: ${dir}`);
  }
  const top = yield* git(dir, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.mapError(() => gitError(`Not a git repository: ${dir}`)),
  );
  return top.trim();
});

// ---------------------------------------------------------------- status

export const status = Effect.fnUntraced(function* (repo: string) {
  const raw = yield* git(repo, [
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
  const result: Status = { head, files, operation: yield* detectOperation(repo) };
  return result;
});

const detectOperation = Effect.fnUntraced(function* (repo: string) {
  const gitDir = (yield* git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  const has = (p: string) => exists(path.join(gitDir, p));
  let operation: Status["operation"] = null;
  if ((yield* has("rebase-merge")) || (yield* has("rebase-apply"))) operation = "rebase";
  else if (yield* has("MERGE_HEAD")) operation = "merge";
  else if (yield* has("CHERRY_PICK_HEAD")) operation = "cherry-pick";
  else if (yield* has("REVERT_HEAD")) operation = "revert";
  return operation;
});

/** Whether git exits 0 for `args`. */
const succeeds = (repo: string, args: string[]) =>
  git(repo, args).pipe(
    Effect.as(true),
    Effect.catchTag("GitError", () => Effect.succeed(false)),
  );

const hasHead = (repo: string) => succeeds(repo, ["rev-parse", "--verify", "-q", "HEAD"]);

// ---------------------------------------------------------------- diff

/**
 * A file's diff against the index, or with `staged`, the index's against HEAD. An untracked file
 * has neither: `untrackedDiff` in `files.ts` diffs it.
 */
export const fileDiff = (
  repo: string,
  opts: {
    path: string;
    origPath?: string;
    staged: boolean;
    /** Output cap; defaults to 8 MB. */
    maxBytes?: number;
  },
) =>
  gitPatch(
    repo,
    [
      "diff",
      "--no-color",
      "-M",
      "--no-ext-diff",
      ...(opts.staged ? ["--cached"] : []),
      "--",
      ...(opts.origPath ? [opts.origPath, opts.path] : [opts.path]),
    ],
    { maxBytes: opts.maxBytes },
  ).pipe(Effect.map(({ patch, truncated }) => ({ diff: patch, truncated })));

// ---------------------------------------------------------------- staging & commit

export const stage = Effect.fnUntraced(function* (repo: string, paths?: string[]) {
  // `git add -A --` with no pathspec stages the whole tree, so an empty list must not reach git.
  if (paths?.length === 0) return yield* gitError("No paths to stage");
  if (!paths) yield* git(repo, ["add", "-A"]);
  else yield* git(repo, ["add", "-A", "--", ...paths]);
});

export const unstage = Effect.fnUntraced(function* (repo: string, paths?: string[]) {
  if (paths?.length === 0) return yield* gitError("No paths to unstage");
  if (!(yield* hasHead(repo))) {
    yield* git(repo, ["rm", "--cached", "-r", "-q", "--", ...(paths ?? ["."])]);
  } else if (!paths) {
    yield* git(repo, ["reset", "-q"]);
  } else {
    // Restoring only the new side of a staged rename would leave the deletion of the old path
    // staged, so restore both sides together.
    const wanted = new Set(paths);
    const renameSources = (yield* status(repo)).files.flatMap((f) =>
      f.x === "R" && f.origPath && wanted.has(f.path) ? [f.origPath] : [],
    );
    yield* git(repo, ["restore", "--staged", "--", ...new Set([...paths, ...renameSources])]);
  }
});

export const discard = (repo: string, file: FileStatus) =>
  Effect.asVoid(
    file.untracked
      ? git(repo, ["clean", "-f", "-q", "--", file.path])
      : git(repo, ["restore", "--worktree", "--", file.path]),
  );

export const commit = (repo: string, message: string, amend: boolean) => {
  const args = ["commit", "-F", "-"];
  if (amend) args.push("--amend");
  if (amend && !message.trim()) args.splice(1, 2, "--no-edit");
  return git(repo, args, { input: message });
};

export const lastCommitMessage = Effect.fnUntraced(function* (repo: string) {
  if (!(yield* hasHead(repo))) return "";
  return yield* git(repo, ["log", "-1", "--format=%B"]);
});

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

type LogOptions = { limit: number; all: boolean; ref?: string };

/** What to walk. An unborn HEAD would make git fail, so it is only named when it resolves. */
const logRevisions = Effect.fnUntraced(function* (repo: string, opts: LogOptions) {
  if (opts.ref) return [opts.ref];
  const head = (yield* hasHead(repo)) ? ["HEAD"] : [];
  // Not --all: that would include tool-internal refs (refs/t3/*, refs/codex/*, refs/original/*, stash).
  // These patterns may match nothing (an unborn repo); git then walks nothing and prints nothing.
  return opts.all ? ["--branches", "--remotes", "--tags", ...head] : head;
});

export const log = Effect.fnUntraced(function* (repo: string, opts: LogOptions) {
  const revisions = yield* logRevisions(repo, opts);
  if (revisions.length === 0) return [];
  return parseLog(
    yield* git(repo, [
      "log",
      "--topo-order",
      "--decorate=full",
      `-n${opts.limit}`,
      `--format=${LOG_FORMAT}`,
      ...revisions,
      "--",
    ]),
  );
});

export const showCommit = Effect.fnUntraced(function* (
  repo: string,
  hash: string,
  opts: { maxBytes?: number } = {},
) {
  const metaRaw = yield* git(repo, [
    "show",
    "-s",
    "--decorate=full",
    `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%cn%x1f%ct%x1f%b`,
    hash,
    "--",
  ]);
  const [h, parents, author, email, date, refs, subject, committer, cdate, body] =
    metaRaw.split("\x1f");
  const { patch, truncated } = yield* gitPatch(
    repo,
    [
      "show",
      "--format=",
      "--no-color",
      "-M",
      "--diff-merges=first-parent",
      "--no-ext-diff",
      hash,
      "--",
    ],
    opts,
  );
  const detail: CommitDetail = {
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
    truncated,
  };
  return detail;
});

// ---------------------------------------------------------------- branches

export const branches = Effect.fnUntraced(function* (repo: string) {
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
  const raw = yield* git(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    `--format=${fmt}`,
    "refs/heads",
    "refs/remotes",
  ]);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line): Branch => {
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
});

export const checkout = Effect.fnUntraced(function* (repo: string, name: string, remote: boolean) {
  if (!remote) return yield* git(repo, ["switch", name]);
  // origin/feature -> create/switch local "feature" tracking it
  const local = name.split("/").slice(1).join("/");
  if (yield* succeeds(repo, ["rev-parse", "--verify", "-q", `refs/heads/${local}`])) {
    return yield* git(repo, ["switch", local]);
  }
  return yield* git(repo, ["switch", "-c", local, "--track", name]);
});

export const createBranch = (repo: string, name: string, from?: string, doCheckout = true) =>
  doCheckout
    ? git(repo, ["switch", "-c", name, ...(from ? [from] : [])])
    : git(repo, ["branch", name, ...(from ? [from] : [])]);

export const deleteBranch = (repo: string, name: string, force: boolean) =>
  git(repo, ["branch", force ? "-D" : "-d", name]);

// ---------------------------------------------------------------- remotes

/** Remote operations can legitimately be slow, but a hung one (e.g. ssh stuck) must not live forever. */
const REMOTE_TIMEOUT_MS = 10 * 60 * 1000;

export const remoteAction = Effect.fnUntraced(function* (
  repo: string,
  action: "fetch" | "pull" | "push",
) {
  const opts = { timeoutMs: REMOTE_TIMEOUT_MS };
  if (action === "fetch") return yield* git(repo, ["fetch", "--all", "--prune"], opts);
  if (action === "pull") return yield* git(repo, ["pull", "--ff-only"], opts);
  const st = yield* status(repo);
  if (!st.head.upstream) {
    const remotes = (yield* git(repo, ["remote"])).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) return yield* gitError("No remote configured");
    return yield* git(repo, ["push", "-u", remote, "HEAD"], opts);
  }
  return yield* git(repo, ["push"], opts);
});
