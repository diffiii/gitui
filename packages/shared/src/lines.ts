// Staging, unstaging and discarding some lines of a file's diff: what the request names, and
// which files it can't be done to. Both sides use the refusals: the server refuses with them, and
// the web app offers only the actions they allow.
import type { FileStatus } from "./types.ts";

/** What `applyLines` does with a file's lines. */
export type LinesAction = "stage" | "unstage" | "discard";

/** Old-side numbers of selected `-` lines and new-side numbers of selected `+` lines. */
export interface LineSelection {
  deletions: number[];
  additions: number[];
}

/**
 * Why `action` can't be done to some lines of `entry` (git's own status entry), or null if it
 * can. `unstage` takes lines of the staged diff, `stage` and `discard` of the unstaged one.
 */
export function partialRefusal(entry: FileStatus, action: LinesAction): string | null {
  if (entry.repository) return `Can't pick lines in a repository: ${entry.path}`;
  if (entry.conflicted) return `Resolve the conflict in ${entry.path} first`;
  // Its lines would need `git add -N` first; staging the whole file, then unstaging lines, works.
  if (entry.untracked) return `Stage the whole file first: ${entry.path}`;
  if (action === "unstage") {
    if (entry.x === ".") return `Nothing staged in ${entry.path}`;
    // The index has no file left for the patch to go back into.
    if (entry.x === "D") return `Unstage the whole file: ${entry.path}`;
    return null;
  }
  // A rename in the work tree (`git add -N`) has two sides, which a content patch can't keep.
  if (entry.y === "R") return `Stage or discard the whole file: ${entry.path}`;
  if (entry.y === ".") return `No unstaged changes in ${entry.path}`;
  // The work tree has no file left for the patch to go back into.
  if (action === "discard" && entry.y === "D") return `Discard the whole file: ${entry.path}`;
  return null;
}
