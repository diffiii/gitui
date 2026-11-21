import { describe, expect, test } from "bun:test";
import type { LineSelection } from "@gitui/shared";
import {
  buildPatch,
  checkSelection,
  type Direction,
  type PatchHunk,
  parseFilePatch,
  quotePath,
} from "./patch.ts";

/** Lines of a diff or a patch, each ended with a newline. */
const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");
const NO_EOL = "\\ No newline at end of file";

/** The content-only header gitui writes on `p`. */
const header = (p: string) => lines(`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`);

const parsed = (diff: string): PatchHunk[] => {
  const hunks = parseFilePatch(diff);
  if ("error" in hunks) throw new Error(hunks.error);
  return hunks;
};

const select = (deletions: number[], additions: number[]): LineSelection => ({
  deletions,
  additions,
});

// a..l -> A b..k L m: a hunk at the top and one at the bottom.
const TWO_HUNKS = lines(
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
);

// The same, with a top hunk that adds a line, so the bottom one moves down by one.
const SHIFTED = lines(
  "diff --git a/f b/f",
  "index 1111111..2222222 100644",
  "--- a/f",
  "+++ b/f",
  "@@ -1,4 +1,5 @@",
  "-a",
  "+A",
  "+A2",
  " b",
  " c",
  " d",
  "@@ -9,4 +10,5 @@ h",
  " i",
  " j",
  " k",
  "-l",
  "+L",
  "+m",
);

const CREATED = lines(
  "diff --git a/n b/n",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/n",
  "@@ -0,0 +1,3 @@",
  "+1",
  "+2",
  "+3",
);

// "a\nb\nc" -> "a\nB\nc\nd": neither side ends with a newline.
const NO_NEWLINE = lines(
  "diff --git a/f b/f",
  "index 1111111..2222222 100644",
  "--- a/f",
  "+++ b/f",
  "@@ -1,3 +1,4 @@",
  " a",
  "-b",
  "-c",
  NO_EOL,
  "+B",
  "+c",
  "+d",
  NO_EOL,
);

const CRLF = lines(
  "diff --git a/w b/w",
  "index 1111111..2222222 100644",
  "--- a/w",
  "+++ b/w",
  "@@ -1,2 +1,3 @@",
  "-a\r",
  "+A\r",
  " b\r",
  "+c\r",
);

const DELETED = lines(
  "diff --git a/d b/d",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/d",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
);

const RENAMED = lines(
  "diff --git a/old b/new",
  "similarity index 80%",
  "rename from old",
  "rename to new",
  "index 1111111..2222222 100644",
  "--- a/old",
  "+++ b/new",
  "@@ -1,2 +1,2 @@",
  "-x",
  "+X",
  " y",
);

// Two lines replaced by two others: the nth `-` pairs with the nth `+`.
const PAIRS = lines(
  "diff --git a/p b/p",
  "--- a/p",
  "+++ b/p",
  "@@ -1,3 +1,3 @@",
  " a",
  "-x1",
  "-x2",
  "+y1",
  "+y2",
);

const built: [string, string, string, LineSelection, Direction, string][] = [
  [
    "a pair at the top of a run: the unselected - stays as context after it",
    PAIRS,
    "p",
    select([2], [2]),
    "forward",
    header("p") + lines("@@ -1,3 +1,3 @@", " a", "-x1", "+y1", " x2"),
  ],
  [
    "a pair at the bottom of a run: the unselected - stays as context before it",
    PAIRS,
    "p",
    select([3], [3]),
    "forward",
    header("p") + lines("@@ -1,3 +1,3 @@", " a", " x1", "-x2", "+y2"),
  ],
  [
    "a pair, reverse: the unselected + stays as context in its place",
    PAIRS,
    "p",
    select([2], [2]),
    "reverse",
    header("p") + lines("@@ -1,3 +1,3 @@", " a", "-x1", "+y1", " y2"),
  ],
  [
    "1. both lines of the second hunk, forward",
    TWO_HUNKS,
    "f",
    select([12], [12, 13]),
    "forward",
    header("f") + lines("@@ -9,4 +9,5 @@ h", " i", " j", " k", "-l", "+L", "+m"),
  ],
  [
    "2. one added line, forward: the unselected - stays as context, the unselected + goes",
    TWO_HUNKS,
    "f",
    select([], [13]),
    "forward",
    header("f") + lines("@@ -9,4 +9,5 @@ h", " i", " j", " k", " l", "+m"),
  ],
  [
    "3. one added line, reverse: the unselected + stays as context, the unselected - goes",
    TWO_HUNKS,
    "f",
    select([], [13]),
    "reverse",
    header("f") + lines("@@ -9,4 +9,5 @@ h", " i", " j", " k", " L", "+m"),
  ],
  [
    "4. the first hunk left out: the second keeps its old start for its new start",
    SHIFTED,
    "f",
    select([], [14]),
    "forward",
    header("f") + lines("@@ -9,4 +9,5 @@ h", " i", " j", " k", " l", "+m"),
  ],
  [
    "4. the first hunk emitted: the second's new start moves by its net change",
    SHIFTED,
    "f",
    select([], [2, 14]),
    "forward",
    header("f") +
      lines("@@ -1,4 +1,5 @@", " a", "+A2", " b", " c", " d") +
      lines("@@ -9,4 +10,5 @@ h", " i", " j", " k", " l", "+m"),
  ],
  [
    "4. reverse, the first hunk left out: the new side (the index) keeps its start",
    SHIFTED,
    "f",
    select([], [14]),
    "reverse",
    header("f") + lines("@@ -10,4 +10,5 @@ h", " i", " j", " k", " L", "+m"),
  ],
  [
    "4. reverse, the first hunk emitted: the old start moves back by its net change",
    SHIFTED,
    "f",
    select([], [2, 14]),
    "reverse",
    header("f") +
      lines("@@ -1,4 +1,5 @@", " A", "+A2", " b", " c", " d") +
      lines("@@ -9,4 +10,5 @@ h", " i", " j", " k", " L", "+m"),
  ],
  [
    "5. a created file, reverse: the old side is no longer empty",
    CREATED,
    "n",
    select([], [2]),
    "reverse",
    header("n") + lines("@@ -1,2 +1,3 @@", " 1", "+2", " 3"),
  ],
  [
    "5. a created file, forward (an empty file in the index)",
    CREATED,
    "n",
    select([], [2]),
    "forward",
    header("n") + lines("@@ -0,0 +1,1 @@", "+2"),
  ],
  [
    "6. no newline: the last line kept as context keeps its marker",
    NO_NEWLINE,
    "f",
    select([2], [2]),
    "forward",
    header("f") + lines("@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", NO_EOL),
  ],
  [
    "6. no newline: the whole hunk, a marker on each side, each - before the + it pairs with",
    NO_NEWLINE,
    "f",
    select([2, 3], [2, 3, 4]),
    "forward",
    header("f") + lines("@@ -1,3 +1,4 @@", " a", "-b", "+B", "-c", NO_EOL, "+c", "+d", NO_EOL),
  ],
  [
    "6. no newline: the change to the last line, without the other",
    NO_NEWLINE,
    "f",
    select([3], [3, 4]),
    "forward",
    header("f") + lines("@@ -1,3 +1,4 @@", " a", " b", "-c", NO_EOL, "+c", "+d", NO_EOL),
  ],
  [
    "7. CRLF lines come out byte for byte",
    CRLF,
    "w",
    select([1], [1, 3]),
    "forward",
    header("w") + lines("@@ -1,2 +1,3 @@", "-a\r", "+A\r", " b\r", "+c\r"),
  ],
  [
    "7. CRLF, a part",
    CRLF,
    "w",
    select([], [3]),
    "forward",
    header("w") + lines("@@ -1,2 +1,3 @@", " a\r", " b\r", "+c\r"),
  ],
  [
    "10. a new file's header becomes the content-only one",
    CREATED,
    "n",
    select([], [1, 2, 3]),
    "reverse",
    header("n") + lines("@@ -0,0 +1,3 @@", "+1", "+2", "+3"),
  ],
  [
    "10. a deleted file's header becomes the content-only one",
    DELETED,
    "d",
    select([1], []),
    "forward",
    header("d") + lines("@@ -1,2 +1,1 @@", "-x", " y"),
  ],
  [
    "10. a rename's header becomes the content-only one, on the new path",
    RENAMED,
    "new",
    select([1], [1]),
    "reverse",
    header("new") + lines("@@ -1,2 +1,2 @@", "-x", "+X", " y"),
  ],
  [
    "a path with a space ends its --- and +++ names with a tab, as git does",
    RENAMED,
    "a b",
    select([1], [1]),
    "forward",
    lines("diff --git a/a b b/a b", "--- a/a b\t", "+++ b/a b\t") +
      lines("@@ -1,2 +1,2 @@", "-x", "+X", " y"),
  ],
  [
    "a path git quotes is quoted in every header line",
    RENAMED,
    'a"b',
    select([1], [1]),
    "forward",
    lines('diff --git "a/a\\"b" "b/a\\"b"', '--- "a/a\\"b"', '+++ "b/a\\"b"') +
      lines("@@ -1,2 +1,2 @@", "-x", "+X", " y"),
  ],
];

describe("buildPatch", () => {
  test.each(built)("%s", (_, diff, path, selection, direction, expected) => {
    expect(buildPatch(parsed(diff), path, selection, direction)).toBe(expected);
  });

  test.each(built)(
    "the side kept whole keeps its start and count: %s",
    (_, diff, path, sel, dir) => {
      const original = parsed(diff);
      const patch = buildPatch(original, path, sel, dir);
      if (typeof patch !== "string") throw new Error(patch.error);
      const kept = (h: PatchHunk) =>
        dir === "forward" ? [h.oldStart, h.oldCount] : [h.newStart, h.newCount];
      const emitted = parsed(patch).map(kept);
      expect(emitted.length).toBeGreaterThan(0);
      const originals = original.map(kept);
      for (const k of emitted) expect(originals).toContainEqual(k);
    },
  );

  const refused: [string, string, LineSelection, Direction, string][] = [
    [
      "6. an added last line after a last line without a newline",
      NO_NEWLINE,
      select([], [4]),
      "forward",
      "Include the change to the file's last line",
    ],
    [
      "6. reverse, the old last line back before lines that stay",
      NO_NEWLINE,
      select([3], []),
      "reverse",
      "Include the change to the file's last line",
    ],
    ["8. an empty selection", TWO_HUNKS, select([], []), "forward", "Nothing selected"],
    [
      "8. a context line's number",
      TWO_HUNKS,
      select([], [11]),
      "forward",
      "The selection names lines this diff doesn't change",
    ],
    [
      "8. a context line's old number",
      TWO_HUNKS,
      select([2], []),
      "forward",
      "The selection names lines this diff doesn't change",
    ],
    [
      "8. a line past the hunks",
      TWO_HUNKS,
      select([40], []),
      "forward",
      "The selection names lines this diff doesn't change",
    ],
  ];
  test.each(refused)("refuses %s", (_, diff, selection, direction, error) => {
    expect(buildPatch(parsed(diff), "f", selection, direction)).toEqual({ error });
  });
});

describe("parseFilePatch", () => {
  test("reads hunks, counts, context and the no-newline marker", () => {
    expect(parsed(NO_NEWLINE)).toEqual([
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 4,
        context: "",
        lines: [
          { kind: " ", text: "a", noEol: false },
          { kind: "-", text: "b", noEol: false },
          { kind: "-", text: "c", noEol: true },
          { kind: "+", text: "B", noEol: false },
          { kind: "+", text: "c", noEol: false },
          { kind: "+", text: "d", noEol: true },
        ],
      },
    ]);
  });

  test("a missing count is 1", () => {
    const one = parsed(
      lines("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -3 +3 @@", "-x", "+y"),
    );
    expect(one[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 });
  });

  const refused: [string, string, string][] = [
    ["an empty diff", "", "Not a single file's diff"],
    [
      "8. binary files",
      lines("diff --git a/b b/b", "index 1..2 100644", "Binary files a/b and b/b differ"),
      "Binary files can't be staged by lines",
    ],
    [
      "8. a binary patch",
      lines("diff --git a/b b/b", "index 1..2 100644", "GIT binary patch", "literal 3", "Kc"),
      "Binary files can't be staged by lines",
    ],
    ["8. two files", TWO_HUNKS + RENAMED, "Not a single file's diff"],
    [
      "8. a combined diff",
      lines("diff --cc f", "index 1,2..3", "--- a/f", "+++ b/f", "@@@ -1,1 -1,1 +1,1 @@@", "- a"),
      "Not a single file's diff",
    ],
    [
      "a mode change alone",
      lines("diff --git a/f b/f", "old mode 100644", "new mode 100755"),
      "No changes to stage by lines",
    ],
    [
      "a hunk shorter than its counts (a cut diff)",
      TWO_HUNKS.slice(0, TWO_HUNKS.lastIndexOf("+m")),
      "Malformed diff",
    ],
    [
      "bytes that weren't UTF-8",
      lines("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-x", "+�"),
      "Only UTF-8 text can be staged by lines",
    ],
  ];
  test.each(refused)("refuses %s", (_, diff, error) => {
    expect(parseFilePatch(diff)).toEqual({ error });
  });
});

describe("checkSelection", () => {
  test("says whether a selection names every changed line", () => {
    const hunks = parsed(TWO_HUNKS);
    expect(checkSelection(hunks, select([1, 12], [1, 12, 13]))).toEqual({ all: true });
    expect(checkSelection(hunks, select([12, 1], [13, 1, 12, 13]))).toEqual({ all: true });
    expect(checkSelection(hunks, select([1, 12], [1, 12]))).toEqual({ all: false });
    expect(checkSelection(hunks, select([], [13]))).toEqual({ all: false });
    expect(checkSelection(hunks, select([], []))).toEqual({ error: "Nothing selected" });
    expect(checkSelection(hunks, select([1, 12], [1, 12, 13, 14]))).toEqual({
      error: "The selection names lines this diff doesn't change",
    });
  });
});

describe("quotePath", () => {
  test.each([
    ["a b.txt", "a b.txt"],
    ['a"b', '"a\\"b"'],
    ["a\tb", '"a\\tb"'],
    ["a\\b", '"a\\\\b"'],
    ["a\nb", '"a\\nb"'],
    ["a\x01b", '"a\\001b"'],
    ["é.txt", "é.txt"],
  ])("9. %j -> %s", (path, quoted) => {
    expect(quotePath(path)).toBe(quoted);
  });
});
