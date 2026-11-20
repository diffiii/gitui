import type { FileTree, FileTreeBatchOperation } from "@pierre/trees";

/** Every folder that holds one of `paths`, as the tree names them: with a trailing `/`. */
export function dirsOf(paths: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i + 1));
  }
  return [...dirs];
}

/**
 * `paths` without any that is also a folder of another, which the tree can't hold (it throws on
 * the collision). Git can list both: a tracked file `a` replaced on disk by a folder `a/` of
 * untracked files.
 */
export function treePaths(paths: readonly string[]): readonly string[] {
  const dirs = new Set(dirsOf(paths));
  return paths.some((p) => dirs.has(`${p}/`)) ? paths.filter((p) => !dirs.has(`${p}/`)) : paths;
}

/**
 * The batch that turns a tree of `prev` into one of `next` in place, so its open folders and
 * search stay as they are. Removing a folder's last file leaves the folder, so folders that hold
 * none of `next` go too, each with what's in it; removals come first, so a file can become a
 * folder of the same name and back.
 */
export function treeChanges(prev: readonly string[], next: readonly string[]) {
  const nextFiles = new Set(next);
  const nextDirs = new Set(dirsOf(next));
  const gone = new Set(dirsOf(prev).filter((d) => !nextDirs.has(d)));
  /** Inside a folder that's removed whole. */
  const inGone = (p: string) => {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      if (gone.has(p.slice(0, i + 1))) return true;
    }
    return false;
  };
  const ops: FileTreeBatchOperation[] = [];
  for (const dir of gone) {
    if (!inGone(dir.slice(0, -1))) ops.push({ type: "remove", path: dir, recursive: true });
  }
  for (const p of prev) if (!nextFiles.has(p) && !inGone(p)) ops.push({ type: "remove", path: p });
  const prevFiles = new Set(prev);
  for (const p of next) if (!prevFiles.has(p)) ops.push({ type: "add", path: p });
  return ops;
}

/**
 * Turns `model`, a tree of `prev`, into one of `next` in place, so the folders the user opened or
 * closed and the search stay; new folders take the tree's `initialExpansion`. Should the tree not
 * hold `prev` after all, the batch throws partway (on a path it lacks, or already has); then the
 * tree is built afresh from `next`, so the next change starts from what it shows.
 */
export function updatePaths(
  model: Pick<FileTree, "batch" | "resetPaths">,
  prev: readonly string[],
  next: readonly string[],
) {
  try {
    model.batch(treeChanges(prev, next));
  } catch {
    model.resetPaths(next);
  }
}
