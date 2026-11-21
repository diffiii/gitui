// Partial patches: one file's unified diff, as `git diff` prints it, parsed into hunks, and the
// patch that stages, unstages or discards some of its changed lines, built from it. Pure: the
// server builds every patch itself, from a diff it has just computed, and a request only names
// lines, so a client can never make gitui apply patch text of its own. What can't be done comes
// back as `{ error }`.
import type { LineSelection } from "@gitui/shared";

export type PatchLine = {
  kind: " " | "-" | "+";
  /** The line as git printed it, without its first character: a trailing `\r` stays. */
  text: string;
  /** `\ No newline at end of file` followed it. */
  noEol: boolean;
};

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** What follows the second `@@` (git's function context), as is. */
  context: string;
  lines: PatchLine[];
}

/** Why a patch can't be read or built. */
export interface Refusal {
  error: string;
}

/** Which way the patch goes: `forward` applies it (stage), `reverse` takes it back. */
export type Direction = "forward" | "reverse";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * The hunks of one file's unified diff, as git prints it (with `diff.suppressBlankEmpty` off, so
 * every line of a hunk starts with ` `, `-`, `+` or `\`); or why it can't be edited by lines.
 */
export function parseFilePatch(diff: string): PatchHunk[] | Refusal {
  const refuse = (error: string) => ({ error });
  // The diff was read as UTF-8: bytes that aren't come back as U+FFFD, and a patch built from
  // them would write U+FFFD in their place.
  if (diff.includes("�")) return refuse("Only UTF-8 text can be staged by lines");
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // Content lines start with ' ', '-', '+' or '\', so a line starting with "diff " is a header.
  const headers = lines.filter((l) => l.startsWith("diff "));
  if (headers.length !== 1 || !lines[0]?.startsWith("diff --git ")) {
    return refuse("Not a single file's diff");
  }
  const hunks: PatchHunk[] = [];
  let i = 1;
  for (; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
    const line = lines[i]!;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      return refuse("Binary files can't be staged by lines");
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = HUNK_HEADER.exec(line);
    if (m) {
      hunks.push({
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        context: m[5]!,
        lines: [],
      });
      continue;
    }
    const hunk = hunks.at(-1);
    const kind = line[0];
    if (!hunk) return refuse("Malformed diff");
    if (kind === " " || kind === "-" || kind === "+") {
      hunk.lines.push({ kind, text: line.slice(1), noEol: false });
    } else if (kind === "\\") {
      const last = hunk.lines.at(-1);
      if (!last || last.noEol) return refuse("Malformed diff");
      last.noEol = true;
    } else {
      return refuse("Malformed diff");
    }
  }
  if (hunks.length === 0) return refuse("No changes to stage by lines");
  for (const h of hunks) {
    const old = h.lines.filter((l) => l.kind !== "+").length;
    const added = h.lines.filter((l) => l.kind !== "-").length;
    if (old !== h.oldCount || added !== h.newCount) return refuse("Malformed diff");
  }
  return hunks;
}

/**
 * Each hunk's lines with their numbers: an old-side number for ` ` and `-`, a new-side one for
 * ` ` and `+`. A side starts at its start, or at 1 when that is 0 (an empty side).
 */
export function numberLines(hunk: PatchHunk) {
  let old = hunk.oldStart || 1;
  let added = hunk.newStart || 1;
  return hunk.lines.map((line) => ({
    line,
    old: line.kind === "+" ? null : old++,
    new: line.kind === "-" ? null : added++,
  }));
}

type NumberedLine = ReturnType<typeof numberLines>[number];

/**
 * Whether `selection` names only changed lines of `hunks`, and whether it names all of them
 * (`all`); or why it can't be used.
 */
export function checkSelection(
  hunks: PatchHunk[],
  selection: LineSelection,
): { all: boolean } | Refusal {
  const deletions = new Set(selection.deletions);
  const additions = new Set(selection.additions);
  if (deletions.size === 0 && additions.size === 0) return { error: "Nothing selected" };
  const changed = { deletions: new Set<number>(), additions: new Set<number>() };
  for (const r of hunks.flatMap(numberLines)) {
    if (r.line.kind === "-") changed.deletions.add(r.old!);
    if (r.line.kind === "+") changed.additions.add(r.new!);
  }
  if (
    [...deletions].some((n) => !changed.deletions.has(n)) ||
    [...additions].some((n) => !changed.additions.has(n))
  ) {
    return { error: "The selection names lines this diff doesn't change" };
  }
  return {
    all: deletions.size === changed.deletions.size && additions.size === changed.additions.size,
  };
}

/** C-style escapes git uses in quoted names. */
const ESCAPES: Record<string, string> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * `path` as git writes it in a patch: in double quotes, with `"`, `\` and control characters
 * escaped, when it has any of those; otherwise as is (non-ASCII stays, as with
 * `core.quotepath=false`).
 */
export function quotePath(path: string): string {
  const quoted = (c: string) => c === '"' || c === "\\" || c < " " || c === "\x7f";
  // UTF-16 units: only ASCII ones are escaped, and the rest join back as they were.
  const chars = path.split("");
  if (!chars.some(quoted)) return path;
  const escaped = chars.map((c) =>
    quoted(c) ? (ESCAPES[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`) : c,
  );
  return `"${escaped.join("")}"`;
}

/** The header of a content-only patch on `path`, as git writes one. */
function patchHeader(path: string) {
  const a = quotePath(`a/${path}`);
  const b = quotePath(`b/${path}`);
  // Git ends a name with a space in `---`/`+++` with a tab, so its end can be told apart.
  const tab = path.includes(" ") ? "\t" : "";
  return `diff --git ${a} ${b}\n--- ${a}${tab}\n+++ ${b}${tab}\n`;
}

/** Whether a line with `\ No newline at end of file` is the last of its side(s) in `lines`. */
function noEolLast(lines: PatchLine[]) {
  return lines.every((line, i) => {
    if (!line.noEol) return true;
    const later = lines.slice(i + 1);
    const oldSide = line.kind !== "+" && later.some((l) => l.kind !== "+");
    const newSide = line.kind !== "-" && later.some((l) => l.kind !== "-");
    return !oldSide && !newSide;
  });
}

/**
 * A hunk's rows in the order the patch lists them: context rows where they are, and in each run
 * of changes between them (git's grouping: its `-` lines, then its `+` lines), the nth `-` and
 * then the nth `+`, so a line the patch keeps as context stays beside the change it pairs with.
 */
function pairedRows(rows: NumberedLine[]): NumberedLine[] {
  const out: NumberedLine[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i]!.line.kind === " ") {
      out.push(rows[i++]!);
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end]!.line.kind !== " ") end++;
    const run = rows.slice(i, end);
    const dels = run.filter((r) => r.line.kind === "-");
    const adds = run.filter((r) => r.line.kind === "+");
    for (let n = 0; n < Math.max(dels.length, adds.length); n++) {
      if (dels[n]) out.push(dels[n]!);
      if (adds[n]) out.push(adds[n]!);
    }
    i = end;
  }
  return out;
}

/**
 * The patch on `path` that applies `selection` of `hunks`' changed lines in `direction`, with
 * git's `apply` (`--reverse` for `reverse`); or why it can't be built.
 *
 * A selected line stays as it is. The side the patch keeps whole (forward the old one, which the
 * index has when staging; reverse the new one, which the index or work tree has) keeps an
 * unselected line as context, and the other side leaves it out: forward, an unselected `-` is
 * context and an unselected `+` goes; reverse, the other way round. Unselected lines pair with
 * selected ones by git's grouping of the diff, the nth `-` with the nth `+` in a run of changes
 * (`pairedRows`), not by how a diff viewer lays them out: `-b -c +B +c` with `-b +B` picked is
 * `-b +B c`, not `-b c +B`. A hunk with nothing selected is left out. The header is always the
 * content-only form on `path`: no mode, new, deleted or rename lines.
 */
export function buildPatch(
  hunks: PatchHunk[],
  path: string,
  selection: LineSelection,
  direction: Direction,
): string | Refusal {
  const checked = checkSelection(hunks, selection);
  if ("error" in checked) return checked;
  const deletions = new Set(selection.deletions);
  const additions = new Set(selection.additions);
  const picked = (r: NumberedLine) =>
    r.line.kind === "-" ? deletions.has(r.old!) : additions.has(r.new!);
  const forward = direction === "forward";
  // The kind the side the patch keeps whole has and the other side lacks.
  const keptKind = forward ? "-" : "+";

  // The other side's net change from the hunks emitted so far.
  let delta = 0;
  let out = patchHeader(path);
  for (const hunk of hunks) {
    const rows = numberLines(hunk);
    if (!rows.some((r) => r.line.kind !== " " && picked(r))) continue;
    const lines = pairedRows(rows).flatMap((r): PatchLine[] => {
      if (r.line.kind === " " || picked(r)) return [r.line];
      return r.line.kind === keptKind ? [{ ...r.line, kind: " " }] : [];
    });
    if (!noEolLast(lines)) return { error: "Include the change to the file's last line" };

    const oldCount = lines.filter((l) => l.kind !== "+").length;
    const newCount = lines.filter((l) => l.kind !== "-").length;
    // The kept side keeps its start and count. The other side's range begins where the kept
    // one's does, moved by what the hunks before it changed; a start names a range's first
    // line, or the line before it when the range is empty.
    const [keptStart, keptCount] = forward
      ? [hunk.oldStart, hunk.oldCount]
      : [hunk.newStart, hunk.newCount];
    const first = (keptCount === 0 ? keptStart + 1 : keptStart) + (forward ? delta : -delta);
    const otherCount = forward ? newCount : oldCount;
    const otherStart = otherCount === 0 ? first - 1 : first;
    const [oldStart, newStart] = forward ? [keptStart, otherStart] : [otherStart, keptStart];
    delta += newCount - oldCount;

    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.context}\n`;
    for (const line of lines) {
      out += `${line.kind}${line.text}\n`;
      if (line.noEol) out += "\\ No newline at end of file\n";
    }
  }
  return out;
}
