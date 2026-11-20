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
