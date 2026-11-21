import { expect, test } from "bun:test";
import type { FileStatus } from "./api.ts";
import {
  canDiscard,
  canEditPartially,
  discardEach,
  filesUnder,
  firstChange,
  lineActions,
  resolveChoice,
  splitChanges,
  splitDiscardable,
  toGitStatus,
} from "./changes.ts";

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

test("toGitStatus marks untracked files whatever their codes", () => {
  expect(toGitStatus(file("a", "?", "?", { untracked: true }), false)).toBe("untracked");
});

test("toGitStatus calls a conflicted file modified", () => {
  expect(toGitStatus(file("a", "U", "U", { conflicted: true }), false)).toBe("modified");
  expect(toGitStatus(file("a", "A", "D", { conflicted: true }), true)).toBe("modified");
});

test("toGitStatus reads x for the staged list and y for the unstaged one", () => {
  const f = file("a", "A", "M");
  expect(toGitStatus(f, true)).toBe("added");
  expect(toGitStatus(f, false)).toBe("modified");
});

test("toGitStatus maps D to deleted and R and C to renamed", () => {
  expect(toGitStatus(file("a", ".", "D"), false)).toBe("deleted");
  expect(toGitStatus(file("a", "R", "."), true)).toBe("renamed");
  expect(toGitStatus(file("a", "C", "."), true)).toBe("renamed");
});

test("filesUnder returns only the file for a file item", () => {
  const files = [file("src/a.ts", ".", "M"), file("src/b/c.ts", ".", "M")];
  expect(filesUnder(files, { kind: "file", path: "src/a.ts" }).map((f) => f.path)).toEqual([
    "src/a.ts",
  ]);
});

test("filesUnder returns a folder's files, not its siblings' with a shared prefix", () => {
  const files = [
    file("src/a.ts", ".", "M"),
    file("src/b/c.ts", ".", "M"),
    file("srcx/a.ts", ".", "M"),
    file("src.ts", ".", "M"),
  ];
  expect(filesUnder(files, { kind: "directory", path: "src/" }).map((f) => f.path)).toEqual([
    "src/a.ts",
    "src/b/c.ts",
  ]);
});

/** A fake `discard` that records the paths it is called with, failing on those in `failing`. */
const fakeDiscard = (failing: string[] = []) => {
  const calls: string[] = [];
  const discard = async (f: FileStatus) => {
    calls.push(f.path);
    if (failing.includes(f.path)) throw new Error("boom");
  };
  return { calls, discard };
};

const five = ["a", "b", "c", "d", "e"].map((p) => file(p, ".", "M"));

test("discardEach discards every file once, in order", async () => {
  const { calls, discard } = fakeDiscard();
  await discardEach(five, discard);
  expect(calls).toEqual(["a", "b", "c", "d", "e"]);
});

test("discardEach rethrows the original error when the first discard fails", async () => {
  const { calls, discard } = fakeDiscard(["a"]);
  await expect(discardEach(five, discard)).rejects.toThrow(new Error("boom"));
  expect(calls).toEqual(["a"]);
});

test("discardEach says how many were discarded when a later one fails", async () => {
  const { calls, discard } = fakeDiscard(["c"]);
  await expect(discardEach(five, discard)).rejects.toThrow(
    "Discarded 2 of 5 files, then c failed: boom",
  );
  expect(calls).toEqual(["a", "b", "c"]);
});

test("canDiscard matches what the server's discard accepts", () => {
  expect(canDiscard(file("a.ts", ".", "M"))).toBe(true);
  expect(canDiscard(file("a.ts", "M", "M"))).toBe(true);
  expect(canDiscard(file("n.ts", ".", "?", { untracked: true }))).toBe(true);
  expect(canDiscard(file("a.ts", "M", "."))).toBe(false);
  expect(canDiscard(file("c.ts", "U", "U", { conflicted: true }))).toBe(false);
  expect(canDiscard(file("sub", ".", "M", { repository: true }))).toBe(false);
  expect(canDiscard(file("nested/", ".", "?", { untracked: true, repository: true }))).toBe(false);
});

test("lineActions matches what the server's partialRefusal allows", () => {
  const cases: [FileStatus, boolean, ReturnType<typeof lineActions>][] = [
    [file("a.ts", ".", "M"), false, ["stage", "discard"]],
    [file("a.ts", "M", "M"), false, ["stage", "discard"]],
    [file("a.ts", "M", "M"), true, ["unstage"]],
    [file("a.ts", "A", "."), true, ["unstage"]],
    [file("n.ts", "R", ".", { origPath: "o.ts" }), true, ["unstage"]],
    [file("n.ts", "R", "M", { origPath: "o.ts" }), false, ["stage", "discard"]],
    [file("d.ts", ".", "D"), false, ["stage"]],
    [file("d.ts", "D", "."), true, []],
    [file("a.ts", "M", "."), false, []],
    [file("a.ts", ".", "M"), true, []],
    [file("n.ts", ".", "R", { origPath: "o.ts" }), false, []],
    [file("u.ts", ".", "?", { untracked: true }), false, []],
    [file("c.ts", "U", "U", { conflicted: true }), false, []],
    [file("c.ts", "U", "U", { conflicted: true }), true, []],
    [file("sub", "M", "M", { repository: true }), false, []],
    [file("sub", "M", "M", { repository: true }), true, []],
  ];
  for (const [f, staged, actions] of cases) {
    expect({ f, staged, actions: lineActions(f, staged) }).toEqual({ f, staged, actions });
    expect(canEditPartially(f, staged)).toBe(actions.length > 0);
  }
});

test("splitDiscardable separates the entries a discard would refuse", () => {
  const ok = file("a.ts", ".", "M");
  const sub = file("sub", ".", "M", { repository: true });
  const conflict = file("c.ts", "U", "U", { conflicted: true });
  expect(splitDiscardable([ok, sub, conflict])).toEqual({
    discardable: [ok],
    skipped: [sub, conflict],
  });
});
