import { expect, test } from "bun:test";
import { FileTree, type FileTreeDirectoryHandle } from "@pierre/trees";
import { dirsOf, treeChanges, treePaths, updatePaths } from "./pathTree.ts";

/** A real tree model, as `PathTree` makes one, with no DOM. */
const tree = (paths: string[], initialExpansion: "open" | "closed" = "open") =>
  new FileTree({ paths, initialExpansion });

/** Every row the tree shows, folders with a trailing `/`; with every folder open, every path. */
const rows = (model: FileTree) =>
  model.getVisibleRows(0, model.getVisibleCount()).map((r) => r.path);

/** What a fresh tree of `paths` shows. */
const rowsOf = (paths: string[]) => rows(tree(paths));

/** The folder `path` of the tree; throws if it has none. */
function folder(model: FileTree, path: string) {
  const item = model.getItem(path);
  if (!item?.isDirectory()) throw new Error(`No folder ${path}`);
  return item as FileTreeDirectoryHandle;
}

const expanded = (model: FileTree, dir: string) => folder(model, dir).isExpanded();

test("dirsOf lists every folder above the paths once", () => {
  expect(dirsOf(["a/b/c.ts", "a/d.ts", "e.ts"]).sort()).toEqual(["a/", "a/b/"]);
});

test("treeChanges adds and removes only what changed", () => {
  expect(treeChanges(["a/x.ts", "b.ts"], ["a/x.ts", "a/y.ts", "c.ts"])).toEqual([
    { type: "remove", path: "b.ts" },
    { type: "add", path: "a/y.ts" },
    { type: "add", path: "c.ts" },
  ]);
  expect(treeChanges(["a.ts"], ["a.ts"])).toEqual([]);
});

test("treeChanges removes a folder left empty, once, with what's in it", () => {
  expect(treeChanges(["a/b/c.ts", "a/b/d.ts", "a/e.ts", "f.ts"], ["f.ts"])).toEqual([
    { type: "remove", path: "a/", recursive: true },
  ]);
  expect(treeChanges(["a/b/c.ts", "a/e.ts"], ["a/e.ts"])).toEqual([
    { type: "remove", path: "a/b/", recursive: true },
  ]);
});

test("treeChanges turns a file into a folder of the same name and back", () => {
  expect(treeChanges(["a"], ["a/b"])).toEqual([
    { type: "remove", path: "a" },
    { type: "add", path: "a/b" },
  ]);
  expect(treeChanges(["a/b"], ["a"])).toEqual([
    { type: "remove", path: "a/", recursive: true },
    { type: "add", path: "a" },
  ]);
});

test("treeChanges turns a real tree of one list into the tree of the next", () => {
  const lists = [
    [],
    ["a/x.ts", "b.ts"],
    ["a/x.ts", "a/y.ts", "c.ts"],
    ["a/b/c.ts", "a/b/d.ts", "a/e.ts", "f.ts"],
    ["f.ts"],
    ["a"],
    ["a/b"],
    ["a/b/c/d.ts", "z.ts"],
    ["z.ts"],
    ["a"],
    [],
  ];
  const model = tree([]);
  for (let i = 1; i < lists.length; i++) {
    model.batch(treeChanges(lists[i - 1], lists[i]));
    expect({ to: lists[i], rows: rows(model) }).toEqual({ to: lists[i], rows: rowsOf(lists[i]) });
  }
});

test("updatePaths keeps folders as the user left them, and opens new ones as the tree does", () => {
  const open = tree(["a/x.ts", "b/y.ts"]);
  folder(open, "a/").collapse();
  updatePaths(open, ["a/x.ts", "b/y.ts"], ["a/x.ts", "a/z.ts", "b/y.ts", "c/w.ts"]);
  expect([expanded(open, "a/"), expanded(open, "b/"), expanded(open, "c/")]).toEqual([
    false,
    true,
    true,
  ]);

  const closed = tree(["a/x.ts", "b/y.ts"], "closed");
  folder(closed, "a/").expand();
  updatePaths(closed, ["a/x.ts", "b/y.ts"], ["a/x.ts", "a/z.ts", "b/y.ts", "c/w.ts"]);
  expect([expanded(closed, "a/"), expanded(closed, "b/"), expanded(closed, "c/")]).toEqual([
    true,
    false,
    false,
  ]);
});

test("updatePaths rebuilds a tree that doesn't hold the paths it was told, and carries on", () => {
  const model = tree(["a.ts", "b.ts"]);
  // Told the tree is empty, so adding a.ts throws "already exists" partway through the batch.
  expect(() => model.batch(treeChanges([], ["a.ts", "c.ts"]))).toThrow("already exists");
  updatePaths(model, [], ["a.ts", "c.ts"]);
  expect(rows(model)).toEqual(rowsOf(["a.ts", "c.ts"]));
  // Told it holds a path it lacks: removing it throws.
  updatePaths(model, ["a.ts", "gone.ts"], ["d/e.ts"]);
  expect(rows(model)).toEqual(rowsOf(["d/e.ts"]));
  // In step again: later changes apply in place.
  updatePaths(model, ["d/e.ts"], ["d/e.ts", "d/f.ts"]);
  expect(rows(model)).toEqual(rowsOf(["d/e.ts", "d/f.ts"]));
});

test("updatePaths recovers when the tree throws on a focused folder that becomes a file", () => {
  // The first row, the flattened `a/b/c/`, has focus. The batch applies, then the tree fails to
  // find that row again through `a`, now a file.
  const model = tree(["a/b/c/d.ts", "z.ts"]);
  expect(model.getFocusedPath()).toBe("a/b/c/");
  expect(() => model.batch(treeChanges(["a/b/c/d.ts", "z.ts"], ["a"]))).toThrow();

  const next = tree(["a/b/c/d.ts", "z.ts"]);
  updatePaths(next, ["a/b/c/d.ts", "z.ts"], ["a"]);
  expect(rows(next)).toEqual(["a"]);
  updatePaths(next, ["a"], ["a", "b/c.ts"]);
  expect(rows(next)).toEqual(rowsOf(["a", "b/c.ts"]));
});

test("treePaths drops a file that is also another path's folder", () => {
  expect(treePaths(["a/b", "a", "c"])).toEqual(["a/b", "c"]);
  const same = ["x/y", "z"];
  expect(treePaths(same)).toBe(same);
});
