// Which changed lines of a parsed diff a hunk or a line selection covers, as the `applyLines`
// request names them: old-side numbers of `-` lines, new-side numbers of `+` lines. Pure, on
// Pierre Diffs' parsed hunks; the server numbers the lines of its own diff the same way.
import type {
  AnnotationSide,
  FileDiffMetadata,
  Hunk,
  SelectedLineRange,
  SelectionSide,
} from "@pierre/diffs";
import type { LineSelection } from "@gitui/shared";

/** One row of a hunk: its kind, its number on each side it has, and where each layout puts it. */
export interface DiffRow {
  kind: "context" | "deletion" | "addition";
  old: number | null;
  new: number | null;
  /** The row's index in the unified layout (a change's deletions, then its additions). */
  unified: number;
  /** Its index in the split layout, where a change's nth deletion and nth addition share a row. */
  split: number;
}

/**
 * The rows of `hunk` in unified order. Each side counts from its start, or from 1 when that is 0
 * (an empty side, which has no lines to number).
 */
export function hunkRows(hunk: Hunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = hunk.deletionStart || 1;
  let added = hunk.additionStart || 1;
  let unified = hunk.unifiedLineStart;
  let split = hunk.splitLineStart;
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let i = 0; i < content.lines; i++) {
        rows.push({
          kind: "context",
          old: old++,
          new: added++,
          unified: unified++,
          split: split++,
        });
      }
      continue;
    }
    for (let i = 0; i < content.deletions; i++) {
      rows.push({ kind: "deletion", old: old++, new: null, unified: unified++, split: split + i });
    }
    for (let i = 0; i < content.additions; i++) {
      rows.push({
        kind: "addition",
        old: null,
        new: added++,
        unified: unified++,
        split: split + i,
      });
    }
    split += Math.max(content.deletions, content.additions);
  }
  return rows;
}

/** The changed lines of `rows`. */
function changedLines(rows: DiffRow[]): LineSelection {
  return {
    deletions: rows.flatMap((r) => (r.kind === "deletion" ? [r.old!] : [])),
    additions: rows.flatMap((r) => (r.kind === "addition" ? [r.new!] : [])),
  };
}

/** Every changed line of the hunk at `hunkIndex`, which must be one of the file's. */
export function hunkLines(file: FileDiffMetadata, hunkIndex: number): LineSelection {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) throw new RangeError(`No hunk ${hunkIndex} in ${file.name}`);
  return changedLines(hunkRows(hunk));
}

/**
 * A hunk's name for its buttons: the lines it spans in the new file, or in the old one when it
 * has none in the new (all of it deleted). It stays the same in the staged and unstaged lists
 * only as far as the line numbers do, but never renumbers with the hunks around it.
 */
export function hunkLabel(hunk: Hunk): string {
  const [start, count] =
    hunk.additionCount > 0
      ? [hunk.additionStart, hunk.additionCount]
      : [hunk.deletionStart, hunk.deletionCount];
  return count === 1 ? `Line ${start}` : `Lines ${start}–${start + count - 1}`;
}

/** Where a hunk's actions go: on its last row, on the side that row reports. */
export function hunkEnd(hunk: Hunk): { side: AnnotationSide; lineNumber: number } | null {
  const last = hunkRows(hunk).at(-1);
  if (!last) return null;
  return last.kind === "deletion"
    ? { side: "deletions", lineNumber: last.old! }
    : { side: "additions", lineNumber: last.new! };
}

export type Layout = "unified" | "split";

/**
 * Where an end of a selection is among `rows`: the index, in `layout`, of the row with that
 * number on that side. A number no row has (a line outside the hunks) sits just after the last
 * row before it on that side.
 */
function position(rows: DiffRow[], side: SelectionSide, lineNumber: number, layout: Layout) {
  const number = (r: DiffRow) => (side === "deletions" ? r.old : r.new);
  const exact = rows.find((r) => number(r) === lineNumber);
  if (exact) return exact[layout];
  const before = rows.filter((r) => number(r) !== null && number(r)! < lineNumber).at(-1);
  return before ? before[layout] + 0.5 : -0.5;
}

/**
 * The changed lines a selection covers: every changed row between its two ends, in `layout`'s
 * row order, as Pierre Diffs highlights them. An end is a line number on its side (a context
 * row reports the additions side in the unified layout); a side left out is `additions`.
 */
export function rangeLines(
  file: FileDiffMetadata,
  range: SelectedLineRange | null,
  layout: Layout,
): LineSelection {
  if (!range) return { deletions: [], additions: [] };
  const rows = file.hunks.flatMap(hunkRows);
  const startSide = range.side ?? "additions";
  const a = position(rows, startSide, range.start, layout);
  const b = position(rows, range.endSide ?? startSide, range.end, layout);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return changedLines(rows.filter((r) => r[layout] >= lo && r[layout] <= hi));
}

/** How many lines a selection names. */
export const lineCount = (sel: LineSelection) => sel.deletions.length + sel.additions.length;
