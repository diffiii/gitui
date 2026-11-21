import type { ContextMenuItem, GitStatusEntry } from "@pierre/trees";
import { type LinesAction, partialRefusal } from "@gitui/shared";
import type { FileStatus } from "./api.ts";

/** A file in the Changes view: its status entry, and whether that's from the staged list. */
export interface ShownFile {
  file: FileStatus;
  staged: boolean;
}

/** Splits status entries into the staged and unstaged lists; a partly staged file is in both. */
export function splitChanges(files: FileStatus[]) {
  return {
    staged: files.filter((f) => f.x !== "." && !f.untracked && !f.conflicted),
    unstaged: files.filter((f) => f.y !== "." || f.untracked || f.conflicted),
  };
}

const find = (list: FileStatus[], path: string) => list.find((f) => f.path === path);

/**
 * The chosen file as the lists stand now: in the list it was chosen from, or in the other one
 * once it was staged or unstaged entirely. Null when there is no choice or the file has no
 * changes left.
 */
export function resolveChoice(
  choice: { path: string; staged: boolean } | null,
  staged: FileStatus[],
  unstaged: FileStatus[],
): ShownFile | null {
  if (!choice) return null;
  const [same, other] = choice.staged ? [staged, unstaged] : [unstaged, staged];
  const inSame = find(same, choice.path);
  if (inSame) return { file: inSame, staged: choice.staged };
  const inOther = find(other, choice.path);
  return inOther ? { file: inOther, staged: !choice.staged } : null;
}

/** The file shown when none is chosen: the first unstaged one, else the first staged one. */
export function firstChange(staged: FileStatus[], unstaged: FileStatus[]): ShownFile | null {
  if (unstaged[0]) return { file: unstaged[0], staged: false };
  if (staged[0]) return { file: staged[0], staged: true };
  return null;
}

/** How the file tree marks a file of the staged (`x`) or unstaged (`y`) list. */
export function toGitStatus(f: FileStatus, staged: boolean): GitStatusEntry["status"] {
  if (f.untracked) return "untracked";
  const c = f.conflicted ? "M" : staged ? f.x : f.y;
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  if (c === "R" || c === "C") return "renamed";
  return "modified";
}

/**
 * The files a tree row's action covers: the file itself, or every file in the folder (whose
 * path ends with `/`).
 */
export function filesUnder(files: FileStatus[], item: Pick<ContextMenuItem, "kind" | "path">) {
  return item.kind === "file"
    ? files.filter((f) => f.path === item.path)
    : files.filter((f) => f.path.startsWith(item.path));
}

/**
 * Discards `files` one at a time, stopping at the first failure. A failure after some
 * succeeded says how many did.
 */
export async function discardEach(
  files: FileStatus[],
  discard: (f: FileStatus) => Promise<unknown>,
): Promise<void> {
  for (const [i, f] of files.entries()) {
    try {
      await discard(f);
    } catch (e) {
      if (i === 0) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Discarded ${i} of ${files.length} files, then ${f.path} failed: ${reason}`);
    }
  }
}

/**
 * Whether the server's discard accepts the entry (`discardCommand` in server/git.ts): not a
 * submodule or nested repository, not conflicted, and something unstaged or untracked.
 */
export function canDiscard(f: FileStatus): boolean {
  if (f.repository || f.conflicted) return false;
  return f.untracked || f.y !== ".";
}

/**
 * What can be done to some lines of `f`'s diff in the staged or the unstaged list: what that
 * list's actions are, less those the server's `partialRefusal` refuses.
 */
export function lineActions(f: FileStatus, staged: boolean): LinesAction[] {
  const actions: LinesAction[] = staged ? ["unstage"] : ["stage", "discard"];
  return actions.filter((a) => !partialRefusal(f, a));
}

/** Whether some lines of `f`'s diff in that list can be staged, unstaged or discarded. */
export const canEditPartially = (f: FileStatus, staged: boolean) =>
  lineActions(f, staged).length > 0;

/** Splits `files` into those a discard can take and those it would refuse. */
export function splitDiscardable(files: FileStatus[]) {
  return {
    discardable: files.filter(canDiscard),
    skipped: files.filter((f) => !canDiscard(f)),
  };
}
