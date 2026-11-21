import { describe, expect, test } from "bun:test";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { hunkEnd, hunkLabel, hunkLines, hunkRows, lineCount, rangeLines } from "./lineSelection.ts";

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");

function parse(patch: string): FileDiffMetadata {
  const files = parsePatchFiles(patch).flatMap((p) => p.files);
  expect(files).toHaveLength(1);
  return files[0]!;
}

// a..l -> A b..k L m: a hunk at the top and one at the bottom, as git prints them.
const TWO_HUNKS = parse(
  lines(
    "diff --git a/f b/f",
    "index 1111111..2222222 100644",
    "--- a/f",
    "+++ b/f",
    "@@ -1,4 +1,4 @@",
    "-a",
    "+A",
    " b",
    " c",
    " d",
    "@@ -9,4 +9,5 @@ h",
    " i",
    " j",
    " k",
    "-l",
    "+L",
    "+m",
  ),
);

const CREATED = parse(
  lines(
    "diff --git a/n b/n",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/n",
    "@@ -0,0 +1,3 @@",
    "+1",
    "+2",
    "+3",
  ),
);

const TRUNCATED_END = parse(
  lines(
    "diff --git a/t b/t",
    "index 1111111..2222222 100644",
    "--- a/t",
    "+++ b/t",
    "@@ -1,3 +1,1 @@",
    " x",
    "-y",
    "-z",
  ),
);

describe("hunkRows", () => {
  test("numbers each side from its start, deletions before additions", () => {
    expect(hunkRows(TWO_HUNKS.hunks[1]!).map((r) => [r.kind, r.old, r.new])).toEqual([
      ["context", 9, 9],
      ["context", 10, 10],
      ["context", 11, 11],
      ["deletion", 12, null],
      ["addition", null, 12],
      ["addition", null, 13],
    ]);
  });

  test("a change's nth deletion and nth addition share a split row", () => {
    const rows = hunkRows(TWO_HUNKS.hunks[1]!);
    expect(rows[3]!.split).toBe(rows[4]!.split);
    expect(rows[5]!.split).toBe(rows[4]!.split + 1);
    expect(rows.map((r) => r.unified)).toEqual(rows.map((_, i) => rows[0]!.unified + i));
  });
});

describe("hunkLines", () => {
  test("names every changed line of a hunk", () => {
    expect(hunkLines(TWO_HUNKS, 0)).toEqual({ deletions: [1], additions: [1] });
    expect(hunkLines(TWO_HUNKS, 1)).toEqual({ deletions: [12], additions: [12, 13] });
    expect(hunkLines(CREATED, 0)).toEqual({ deletions: [], additions: [1, 2, 3] });
    expect(() => hunkLines(TWO_HUNKS, 2)).toThrow(RangeError);
  });
});

describe("hunkLabel", () => {
  test("names the new lines a hunk spans, or the old ones when it has none", () => {
    expect(hunkLabel(TWO_HUNKS.hunks[0]!)).toBe("Lines 1–4");
    expect(hunkLabel(TWO_HUNKS.hunks[1]!)).toBe("Lines 9–13");
    expect(hunkLabel(TRUNCATED_END.hunks[0]!)).toBe("Line 1");
    const deleted = parse(
      lines(
        "diff --git a/d b/d",
        "deleted file mode 100644",
        "--- a/d",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-x",
        "-y",
      ),
    );
    expect(hunkLabel(deleted.hunks[0]!)).toBe("Lines 1–2");
  });
});

describe("hunkEnd", () => {
  test("is the hunk's last row, on the side it reports", () => {
    expect(hunkEnd(TWO_HUNKS.hunks[0]!)).toEqual({ side: "additions", lineNumber: 4 });
    expect(hunkEnd(TWO_HUNKS.hunks[1]!)).toEqual({ side: "additions", lineNumber: 13 });
    expect(hunkEnd(TRUNCATED_END.hunks[0]!)).toEqual({ side: "deletions", lineNumber: 3 });
  });
});

describe("rangeLines", () => {
  test("no selection names no lines", () => {
    expect(rangeLines(TWO_HUNKS, null, "unified")).toEqual({ deletions: [], additions: [] });
  });

  test("a range inside one change", () => {
    expect(
      rangeLines(
        TWO_HUNKS,
        { start: 12, side: "deletions", end: 13, endSide: "additions" },
        "unified",
      ),
    ).toEqual({ deletions: [12], additions: [12, 13] });
    expect(rangeLines(TWO_HUNKS, { start: 12, side: "additions", end: 13 }, "unified")).toEqual({
      deletions: [],
      additions: [12, 13],
    });
    expect(rangeLines(TWO_HUNKS, { start: 13, end: 13, side: "additions" }, "unified")).toEqual({
      deletions: [],
      additions: [13],
    });
  });

  test("a range over context rows and two hunks, either way round", () => {
    const down = { start: 1, side: "additions", end: 12, endSide: "deletions" } as const;
    expect(rangeLines(TWO_HUNKS, down, "unified")).toEqual({ deletions: [12], additions: [1] });
    const up = { start: 12, side: "deletions", end: 1, endSide: "additions" } as const;
    expect(rangeLines(TWO_HUNKS, up, "unified")).toEqual({ deletions: [12], additions: [1] });
    const all = { start: 1, side: "deletions", end: 13, endSide: "additions" } as const;
    expect(rangeLines(TWO_HUNKS, all, "unified")).toEqual({
      deletions: [1, 12],
      additions: [1, 12, 13],
    });
  });

  test("a range of context rows only names nothing", () => {
    // Context rows report the additions side, the default.
    expect(rangeLines(TWO_HUNKS, { start: 2, end: 4 }, "unified")).toEqual({
      deletions: [],
      additions: [],
    });
    expect(rangeLines(TWO_HUNKS, { start: 9, end: 11, side: "additions" }, "unified")).toEqual({
      deletions: [],
      additions: [],
    });
  });

  test("in the split layout a row holds a deletion and its addition", () => {
    const row = { start: 12, side: "deletions", end: 12 } as const;
    expect(rangeLines(TWO_HUNKS, row, "split")).toEqual({ deletions: [12], additions: [12] });
    expect(rangeLines(TWO_HUNKS, row, "unified")).toEqual({ deletions: [12], additions: [] });
  });

  test("an end outside the hunks counts from the rows around it", () => {
    // New line 6 is in the gap between the hunks.
    expect(rangeLines(TWO_HUNKS, { start: 6, end: 13 }, "unified")).toEqual({
      deletions: [12],
      additions: [12, 13],
    });
  });
});

test("lineCount", () => {
  expect(lineCount({ deletions: [1], additions: [2, 3] })).toBe(3);
  expect(lineCount({ deletions: [], additions: [] })).toBe(0);
});
