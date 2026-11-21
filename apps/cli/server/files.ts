// The working copy's files, read straight from disk. Every path a request names goes through
// `assertWorkingFile`, which only lets through files git itself lists, with no symlink or git
// directory on the way; `workingFile` then reads one without following a symlink or reading past
// a cap, and `untrackedDiff` diffs one.
//
// These read with node:fs rather than Effect's FileSystem: they need O_NOFOLLOW and O_NONBLOCK,
// lstat, and bigint device and inode numbers, which it doesn't offer. Each call is wrapped in an
// Effect, so these compose like the rest of the server.
import { constants } from "node:fs";
import { lstat, open, readlink, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WorkingFile, WorkingFiles } from "@gitui/shared";
import { Effect } from "effect";
import { git, GitError, gitError, gitPatch, run } from "./git.ts";

export type { WorkingFile, WorkingFiles };

const WINDOWS = process.platform === "win32";

/** Why a directory on a path's way can't be read through, or `ok`. */
type DirCheck = "ok" | "symlink" | "missing" | "gitDir";

/** Node's `promise`, as an Effect that never fails: a rejection is `null`. */
const orNull = <A>(promise: () => Promise<A>): Effect.Effect<A | null> =>
  Effect.promise(() => promise().catch(() => null));

/**
 * Checks a path's leading directories, each once per checker: no symlink, every one a directory,
 * and none of them a git directory. That is the repo's own (`--separate-git-dir` can put it in
 * the work tree under any name), known by device and inode so no case or Unicode variant of its
 * name gets past, or one that looks like a git directory, as a bare repo copied into the tree.
 */
const dirChecker = Effect.fnUntraced(function* (repo: string) {
  const out = yield* git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const gitDirs = new Set<string>();
  for (const dir of out.split("\n")) {
    const st = dir ? yield* orNull(() => stat(dir, { bigint: true })) : null;
    if (st) gitDirs.add(`${st.dev}:${st.ino}`);
  }

  const checkDir = Effect.fnUntraced(function* (abs: string) {
    const st = yield* orNull(() => lstat(abs, { bigint: true }));
    if (st?.isSymbolicLink()) return "symlink" as const;
    if (!st?.isDirectory()) return "missing" as const;
    if (gitDirs.has(`${st.dev}:${st.ino}`) || (yield* looksLikeGitDir(abs))) {
      return "gitDir" as const;
    }
    return "ok" as const;
  });
  // A work tree can be its own git directory (`core.worktree = .` in a bare repo, or
  // GIT_DIR = GIT_WORK_TREE): then everything in it is.
  const rootSt = yield* Effect.promise(() => stat(repo, { bigint: true }));
  const root: DirCheck = gitDirs.has(`${rootSt.dev}:${rootSt.ino}`) ? "gitDir" : "ok";
  // Each directory's check, shared by every path under it, even while it runs.
  const cache = new Map<string, Effect.Effect<DirCheck>>();
  /** `dir`, a repo-relative directory, checked after each one above it. */
  const check = (dir: string): Effect.Effect<DirCheck> => {
    let result = cache.get(dir);
    if (!result) {
      const slash = dir.lastIndexOf("/");
      const parent = slash === -1 ? Effect.succeed(root) : check(dir.slice(0, slash));
      result = Effect.runSync(
        Effect.cached(
          Effect.flatMap(parent, (p) =>
            p === "ok" ? checkDir(path.join(repo, dir)) : Effect.succeed(p),
          ),
        ),
      );
      cache.set(dir, result);
    }
    return result;
  };
  /** The first problem with the directories that lead to `file`, or `ok`. */
  return (file: string): Effect.Effect<DirCheck> => {
    const slash = file.lastIndexOf("/");
    return slash === -1 ? Effect.succeed(root) : check(file.slice(0, slash));
  };
});

/**
 * Git's `is_git_directory()`, a little stricter: a `HEAD` and `objects` and `refs`, or a `HEAD`
 * and a `commondir`, as a linked worktree's git directory has. Only asked of the directories on a
 * path's way, and most have no `HEAD`, so it usually costs one `lstat`.
 */
const looksLikeGitDir = Effect.fnUntraced(function* (dir: string) {
  const has = (name: string) =>
    Effect.promise(() =>
      lstat(path.join(dir, name)).then(
        () => true,
        () => false,
      ),
    );
  if (!(yield* has("HEAD"))) return false;
  if (yield* has("commondir")) return true;
  return (yield* has("objects")) && (yield* has("refs"));
});

/** The working copy's files, up to `limit` of them. */
export const workingFiles = Effect.fnUntraced(function* (repo: string, limit = 50_000) {
  const checkPath = yield* dirChecker(repo);
  // One run lists tracked (`H`), untracked (`?`), deleted (`R`) and skip-worktree (`S`) paths. A
  // deleted file comes twice, `H` then `R`; a conflicted one once per stage, as `M`; a nested
  // repo as `dir/`, with a `?`.
  const { stdout, truncated } = yield* run(repo, [
    "ls-files",
    "--cached",
    "--others",
    "--deleted",
    "--exclude-standard",
    "-t",
    "-z",
  ]);
  const entries = stdout.split("\0");
  // The empty string after the last NUL, or the path the byte cap cut short.
  entries.pop();
  // Cut output may have lost the `R` that follows the last entry.
  if (truncated) entries.pop();
  const deleted = new Set<string>();
  const listed = new Set<string>();
  /** Skip-worktree: left out of a sparse checkout, or marked so by hand and still there. */
  const skipped = new Set<string>();
  for (const entry of entries) {
    const tag = entry[0];
    const p = entry.slice(2);
    if (tag === "R") deleted.add(p);
    else if (p.endsWith("/")) continue;
    else if (tag === "S") skipped.add(p);
    else listed.add(p);
  }
  // Read's rule, once per folder: a tracked path whose folder is now a symlink is still listed
  // (git's `--deleted` check follows it), and git lists what's in a git directory not named `.git`.
  const candidates = [...listed, ...skipped];
  const keep = yield* Effect.forEach(
    candidates,
    Effect.fnUntraced(function* (p) {
      if (deleted.has(p) || (yield* checkPath(p)) !== "ok") return false;
      if (!skipped.has(p)) return true;
      const st = yield* orNull(() => lstat(path.join(repo, p)));
      return !!st && !st.isDirectory();
    }),
    { concurrency: "unbounded" },
  );
  const paths = candidates.filter((_, i) => keep[i]);
  const files: WorkingFiles = {
    paths: paths.slice(0, limit),
    truncated: truncated || paths.length > limit,
  };
  return files;
});

const notListed = (file: string, untracked: boolean): Effect.Effect<never, GitError> =>
  Effect.fail(
    gitError(
      untracked
        ? `Not an untracked file in this repository: ${file}`
        : `Not a file in the working copy: ${file}`,
    ),
  );

/**
 * Fails unless `file` is exactly one of the paths git lists in `repo`'s working copy (with
 * `untracked`, an untracked one that isn't ignored), and neither a symlink nor a git directory
 * leads to it.
 *
 * Git's own rule (`has_symlink_leading_path`): a path is never read through a symlinked
 * directory, even one pointing inside the repo, since `x -> .git` would expose `.git/config` as
 * the tracked `x/config`. The last component may itself be a symlink; readers must not follow it.
 */
export const assertWorkingFile = Effect.fnUntraced(function* (
  repo: string,
  file: string,
  { untracked = false }: { untracked?: boolean } = {},
) {
  const parts = file.split(WINDOWS ? /[/\\]/ : "/");
  // Git never tracks a `.git` component, nor lists one as untracked; refuse it before asking. An
  // empty one is a folder (`ls-files -o` lists a nested repo as `nested/`) or an absolute path.
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.toLowerCase() === ".git")) {
    return yield* notListed(file, untracked);
  }
  // `:(literal)` turns off pathspec magic; an absolute path outside the repo makes git fail.
  const listed = yield* git(repo, [
    "ls-files",
    ...(untracked ? [] : ["--cached"]),
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    `:(literal)${file}`,
  ]).pipe(Effect.orElseSucceed(() => ""));
  if (!listed.split("\0").includes(file)) return yield* notListed(file, untracked);

  switch (yield* (yield* dirChecker(repo))(file)) {
    case "ok":
      return;
    case "symlink":
      return yield* gitError(`Behind a symbolic link: ${file}`);
    case "gitDir":
      return yield* gitError(`Inside a git directory: ${file}`);
    case "missing":
      return yield* notListed(file, untracked);
  }
});

/**
 * An untracked file's diff against nothing. `git diff --no-index` reads whatever path it's given,
 * inside the repo or not, so this only diffs one `assertWorkingFile` passes.
 */
export const untrackedDiff = Effect.fnUntraced(function* (
  repo: string,
  file: string,
  { maxBytes }: { maxBytes?: number } = {},
) {
  yield* assertWorkingFile(repo, file, { untracked: true });
  const { patch, truncated } = yield* gitPatch(
    repo,
    ["diff", "--no-index", "--no-color", "--", "/dev/null", file],
    { okCodes: [0, 1], maxBytes },
  );
  return { diff: patch, truncated };
});

/** Files larger than this are reported by size rather than read. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Like git, a file is binary when a NUL byte appears in its first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * O_NOFOLLOW: a symlink makes `open` fail (ELOOP; EMLINK on FreeBSD) rather than be followed.
 * Windows has neither flag (`?? 0`); `workingFile` checks for a symlink there with `lstat` first.
 * O_NONBLOCK: a FIFO swapped in opens at once instead of blocking a libuv thread for a writer.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** What opening a working-copy file gave: its handle, a symlink, or nothing readable. */
type Opened = { handle: FileHandle } | { symlink: true } | null;

/**
 * Reads `file`, a repo-relative path, from the working copy, once `assertWorkingFile` passes it.
 * A symlink is never followed: its target is returned instead. At most `maxBytes + 1` bytes are
 * read, however large the file is or grows.
 *
 * Accepted risk: a leading directory swapped for a symlink between `assertWorkingFile` and the
 * `open` is still followed, since Node has no `openat` to open each component in turn, and so is
 * one turned into (or replaced by) a git directory. Either needs someone with write access to the
 * working copy racing the request.
 */
export const workingFile = Effect.fnUntraced(function* (
  repo: string,
  file: string,
  maxBytes = MAX_FILE_BYTES,
) {
  yield* assertWorkingFile(repo, file);
  const abs = path.join(repo, file);
  const symlink = Effect.fnUntraced(function* () {
    const target = yield* orNull(() => readlink(abs));
    if (target === null) return yield* notListed(file, false);
    const link: WorkingFile = { kind: "symlink", target };
    return link;
  });

  // Without O_NOFOLLOW, refuse to follow a symlink here; one swapped in before the `open` is
  // followed, a race like the one above.
  if (WINDOWS) {
    const st = yield* orNull(() => lstat(abs));
    if (st === null) return yield* notListed(file, false);
    if (st.isSymbolicLink()) return yield* symlink();
  }
  const opened: Opened = yield* Effect.promise(() =>
    open(abs, OPEN_FLAGS).then(
      (handle): Opened => ({ handle }),
      (e: NodeJS.ErrnoException): Opened =>
        e.code === "ELOOP" || e.code === "EMLINK" ? { symlink: true } : null,
    ),
  );
  if (opened === null) return yield* notListed(file, false);
  if ("symlink" in opened) return yield* symlink();
  const { handle } = opened;
  return yield* read(handle, file, maxBytes).pipe(
    Effect.ensuring(Effect.promise(() => handle.close())),
  );
});

/** Reads an open working-copy file, as `workingFile` describes. */
const read = Effect.fnUntraced(function* (handle: FileHandle, file: string, maxBytes: number) {
  const st = yield* Effect.promise(() => handle.stat());
  // Not a FIFO or device, which could block or never end, nor a directory (a submodule).
  if (!st.isFile()) return yield* gitError(`Not a regular file: ${file}`);
  let result: WorkingFile;
  if (st.size > maxBytes) {
    result = { kind: "tooLarge", size: st.size };
    return result;
  }
  // The file may have grown since the stat: one byte past the cap says so.
  const buf = Buffer.alloc(maxBytes + 1);
  let size = 0;
  while (size < buf.length) {
    const at = size;
    const { bytesRead } = yield* Effect.promise(() => handle.read(buf, at, buf.length - at, at));
    if (!bytesRead) break;
    size += bytesRead;
  }
  const data = buf.subarray(0, size);
  if (size > maxBytes) result = { kind: "tooLarge", size: Math.max(st.size, size) };
  else if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) result = { kind: "binary", size };
  else result = { kind: "text", size, content: data.toString("utf8") };
  return result;
});
