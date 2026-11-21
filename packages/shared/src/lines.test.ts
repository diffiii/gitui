import { expect, test } from "bun:test";
import { type LinesAction, partialRefusal } from "./lines.ts";
import type { FileStatus } from "./types.ts";

const entry = (e: Partial<FileStatus>): FileStatus => ({ x: ".", y: "M", path: "f", ...e });

const cases: [Partial<FileStatus>, LinesAction, string | null][] = [
  [{}, "stage", null],
  [{}, "discard", null],
  [{ x: "M", y: "M" }, "unstage", null],
  [{ x: "A", y: "M" }, "unstage", null],
  [{ x: "R", y: ".", origPath: "o" }, "unstage", null],
  [{ x: "R", y: "M", origPath: "o" }, "stage", null],
  [{ y: "D" }, "stage", null],
  [{ repository: true }, "stage", "Can't pick lines in a repository: f"],
  [{ repository: true }, "discard", "Can't pick lines in a repository: f"],
  [{ x: "M", repository: true }, "unstage", "Can't pick lines in a repository: f"],
  [{ x: "U", y: "U", conflicted: true }, "stage", "Resolve the conflict in f first"],
  [{ x: "U", y: "U", conflicted: true }, "unstage", "Resolve the conflict in f first"],
  [{ y: "?", untracked: true }, "stage", "Stage the whole file first: f"],
  [{ y: "?", untracked: true }, "discard", "Stage the whole file first: f"],
  [{ y: "R", origPath: "o" }, "stage", "Stage or discard the whole file: f"],
  [{ y: "R", origPath: "o" }, "discard", "Stage or discard the whole file: f"],
  [{ x: "M", y: "." }, "stage", "No unstaged changes in f"],
  [{ x: "M", y: "." }, "discard", "No unstaged changes in f"],
  [{}, "unstage", "Nothing staged in f"],
  [{ y: "D" }, "discard", "Discard the whole file: f"],
  [{ x: "D", y: "." }, "unstage", "Unstage the whole file: f"],
];

test.each(cases)("partialRefusal(%o, %s) is %p", (e, action, refusal) => {
  expect(partialRefusal(entry(e), action)).toBe(refusal);
});
