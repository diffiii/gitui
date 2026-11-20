import { expect, test } from "bun:test";
import type { FileStatus } from "./api.ts";
import { firstChange, resolveChoice, splitChanges } from "./changes.ts";

const file = (path: string, x: string, y: string, extra: Partial<FileStatus> = {}): FileStatus => ({
  path,
  x,
  y,
  ...extra,
});

test("splitChanges puts partly staged files in both lists and untracked ones only in unstaged", () => {
  const { staged, unstaged } = splitChanges([
    file("staged.ts", "M", "."),
    file("both.ts", "M", "M"),
    file("worktree.ts", ".", "M"),
    file("new.ts", "?", "?", { untracked: true }),
    file("conflict.ts", "U", "U", { conflicted: true }),
  ]);
  expect(staged.map((f) => f.path)).toEqual(["staged.ts", "both.ts"]);
  expect(unstaged.map((f) => f.path)).toEqual(["both.ts", "worktree.ts", "new.ts", "conflict.ts"]);
});

const shown = (r: { file: FileStatus; staged: boolean } | null) =>
  r && { path: r.file.path, staged: r.staged };

test("resolveChoice keeps a choice that is still listed", () => {
  const { staged, unstaged } = splitChanges([file("a.ts", "M", "M")]);
  expect(shown(resolveChoice({ path: "a.ts", staged: false }, staged, unstaged))).toEqual({
    path: "a.ts",
    staged: false,
  });
  expect(shown(resolveChoice({ path: "a.ts", staged: true }, staged, unstaged))).toEqual({
    path: "a.ts",
    staged: true,
  });
});

test("resolveChoice follows a file into the other list", () => {
  const { staged, unstaged } = splitChanges([file("a.ts", "M", ".")]);
  expect(shown(resolveChoice({ path: "a.ts", staged: false }, staged, unstaged))).toEqual({
    path: "a.ts",
    staged: true,
  });
});

test("resolveChoice drops a discarded or committed file, so its detail closes", () => {
  const { staged, unstaged } = splitChanges([file("b.ts", ".", "M")]);
  expect(resolveChoice({ path: "a.ts", staged: false }, staged, unstaged)).toBeNull();
  expect(resolveChoice(null, staged, unstaged)).toBeNull();
});

test("firstChange prefers unstaged files", () => {
  const { staged, unstaged } = splitChanges([file("s.ts", "M", "."), file("u.ts", ".", "M")]);
  expect(shown(firstChange(staged, unstaged))).toEqual({ path: "u.ts", staged: false });
  expect(shown(firstChange(staged, []))).toEqual({ path: "s.ts", staged: true });
  expect(firstChange([], [])).toBeNull();
});
