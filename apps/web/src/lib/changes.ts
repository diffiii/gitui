import type { FileStatus } from "./api.ts";

/** A file in the Changes view: its path, and whether it's the staged or the unstaged entry. */
export interface FileChoice {
  path: string;
  staged: boolean;
}

/** Splits status entries into the staged and unstaged lists; a partly staged file is in both. */
export function splitChanges(files: FileStatus[]) {
  return {
    staged: files.filter((f) => f.x !== "." && !f.untracked && !f.conflicted),
    unstaged: files.filter((f) => f.y !== "." || f.untracked || f.conflicted),
  };
}

const has = (list: FileStatus[], path: string) => list.some((f) => f.path === path);

/**
 * The chosen file as the lists stand now: as chosen, or in the other list once it was staged or
 * unstaged entirely. Null when there is no choice or the file has no changes left.
 */
export function resolveChoice(
  choice: FileChoice | null,
  staged: FileStatus[],
  unstaged: FileStatus[],
): FileChoice | null {
  if (!choice) return null;
  if (has(choice.staged ? staged : unstaged, choice.path)) return choice;
  if (has(choice.staged ? unstaged : staged, choice.path))
    return { path: choice.path, staged: !choice.staged };
  return null;
}

/** The file shown when none is chosen: the first unstaged one, else the first staged one. */
export function firstChange(staged: FileStatus[], unstaged: FileStatus[]): FileChoice | null {
  if (unstaged[0]) return { path: unstaged[0].path, staged: false };
  if (staged[0]) return { path: staged[0].path, staged: true };
  return null;
}
