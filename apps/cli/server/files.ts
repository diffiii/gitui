// The working copy's files, read straight from disk. Every path a request names goes through
// `assertWorkingFile`, which only lets through files git itself lists and that no symlink leads
// to; `workingFile` then reads one without following a symlink or reading past a cap.
import { constants } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WorkingFile, WorkingFiles } from "@gitui/shared";
import { git, GitError, run } from "./git.ts";

export type { WorkingFile, WorkingFiles };

/** The working copy's files, up to `limit` of them. */
export async function workingFiles(repo: string, limit = 50_000): Promise<WorkingFiles> {
  // One run lists tracked (`H`), untracked (`?`), deleted (`R`) and skip-worktree (`S`) paths. A
  // deleted file comes twice, `H` then `R`; a conflicted one once per stage, as `M`; a nested
  // repo as `dir/`, with a `?`.
  const { stdout, truncated } = await run(repo, [
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
  const missing = new Set<string>();
  const listed = new Set<string>();
  for (const entry of entries) {
    const tag = entry[0];
    const p = entry.slice(2);
    // Deleted from disk, or left out of a sparse checkout.
    if (tag === "R" || tag === "S") missing.add(p);
    else if (!p.endsWith("/")) listed.add(p);
  }
  // A tracked path whose folder is now a symlink is still listed, next to the symlink: git's
  // `--deleted` check follows it. Such a path isn't there, and reading it is refused.
  const behindFile = (p: string) => {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      if (listed.has(p.slice(0, i))) return true;
    }
    return false;
  };
  const paths = [...listed].filter((p) => !missing.has(p) && !behindFile(p));
  return { paths: paths.slice(0, limit), truncated: truncated || paths.length > limit };
}

const notListed = (file: string, untracked: boolean): never => {
  throw new GitError(
    untracked
      ? `Not an untracked file in this repository: ${file}`
      : `Not a file in the working copy: ${file}`,
    null,
    "",
  );
};

/**
 * Throws unless `file` is exactly one of the paths git lists in `repo`'s working copy (with
 * `untracked`, an untracked one that isn't ignored), and no symlink leads to it.
 *
 * Git's own rule (`has_symlink_leading_path`): a path is never read through a symlinked
 * directory, even one pointing inside the repo, since `x -> .git` would expose `.git/config` as
 * the tracked `x/config`. The last component may itself be a symlink; readers must not follow it.
 */
export async function assertWorkingFile(
  repo: string,
  file: string,
  { untracked = false }: { untracked?: boolean } = {},
) {
  const parts = file.split("/");
  // Git never tracks a `.git` component, nor lists one as untracked; refuse it before asking.
  if (parts.some((p) => p.toLowerCase() === ".git")) notListed(file, untracked);
  // `:(literal)` turns off pathspec magic; an absolute path outside the repo makes git fail.
  const listed = await git(repo, [
    "ls-files",
    ...(untracked ? [] : ["--cached"]),
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    `:(literal)${file}`,
  ]).catch(() => "");
  if (!listed.split("\0").includes(file)) notListed(file, untracked);

  let dir = repo;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = await lstat(dir).catch(() => null);
    if (st?.isSymbolicLink()) {
      throw new GitError(`Behind a symbolic link: ${file}`, null, "");
    }
    if (!st?.isDirectory()) notListed(file, untracked);
  }
}

/** Files larger than this are reported by size rather than read. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Like git, a file is binary when a NUL byte appears in its first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

const WINDOWS = process.platform === "win32";
/**
 * O_NOFOLLOW: a symlink makes `open` fail (ELOOP; EMLINK on FreeBSD) rather than be followed.
 * Windows has neither flag (`?? 0`); `workingFile` checks for a symlink there with `lstat` first.
 * O_NONBLOCK: a FIFO swapped in opens at once instead of blocking a libuv thread for a writer.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Reads `file`, a repo-relative path, from the working copy, once `assertWorkingFile` passes it.
 * A symlink is never followed: its target is returned instead. At most `maxBytes + 1` bytes are
 * read, however large the file is or grows.
 *
 * Accepted risk: a leading directory swapped for a symlink between `assertWorkingFile` and the
 * `open` is still followed, since Node has no `openat` to open each component in turn. That needs
 * someone with write access to the working copy racing the request.
 */
export async function workingFile(
  repo: string,
  file: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<WorkingFile> {
  await assertWorkingFile(repo, file);
  const abs = path.join(repo, file);
  const symlink = async (): Promise<WorkingFile> => ({
    kind: "symlink",
    target: await readlink(abs).catch(() => notListed(file, false)),
  });

  // Without O_NOFOLLOW, refuse to follow a symlink here; one swapped in before the `open` is
  // followed, a race like the one above.
  if (WINDOWS && (await lstat(abs).catch(() => notListed(file, false))).isSymbolicLink()) {
    return symlink();
  }
  let handle: FileHandle;
  try {
    handle = await open(abs, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return symlink();
    return notListed(file, false);
  }
  try {
    const st = await handle.stat();
    // Not a FIFO or device, which could block or never end, nor a directory (a submodule).
    if (!st.isFile()) throw new GitError(`Not a regular file: ${file}`, null, "");
    if (st.size > maxBytes) return { kind: "tooLarge", size: st.size };
    // The file may have grown since the stat: one byte past the cap says so.
    const buf = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buf.length) {
      const { bytesRead } = await handle.read(buf, size, buf.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) return { kind: "tooLarge", size: Math.max(st.size, size) };
    const data = buf.subarray(0, size);
    if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary", size };
    return { kind: "text", size, content: data.toString("utf8") };
  } finally {
    await handle.close();
  }
}
