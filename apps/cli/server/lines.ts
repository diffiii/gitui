// Staging, unstaging and discarding some lines of a file: the request names lines of a diff it
// was shown (by its `base`), and everything else comes from git: the file's status entry, the
// diff computed again, and the patch, which patch.ts builds from it.
import { createHash } from "node:crypto";
import { type LinesRequest, partialRefusal } from "@gitui/shared";
import { Effect } from "effect";
import * as g from "./git.ts";
import { buildPatch, checkSelection, parseFilePatch } from "./patch.ts";

/**
 * What identifies a diff for `applyLines`: the SHA-256 of its text. The `/diff` route and
 * `applyLines` both hash what `fileDiff` gives for the same file, so a change to the file (or
 * the index) since the page was shown its diff is refused, not applied to the wrong lines.
 */
export const diffBase = (diff: string) => createHash("sha256").update(diff).digest("hex");

/**
 * Stages, unstages or discards some changed lines of the file at `req.path`. Its entry comes
 * from git's own status, never from the request; its diff is computed again and must be the one
 * the client was shown. A selection of every changed line does what the whole-file action does
 * (so a deletion or a new file goes with it, and a mode change too); any other is a patch.
 */
export const applyLines = Effect.fnUntraced(function* (repo: string, req: LinesRequest) {
  // Not limited to `path`: git pairs a rename's two sides only when it sees both.
  const { stdout } = yield* g.run(repo, g.statusArgs);
  const entry = g.parseStatus(stdout).files.find((f) => f.path === req.path);
  if (!entry) return yield* g.gitError(`No changes in ${req.path}`);
  const refusal = partialRefusal(entry, req.action);
  if (refusal) return yield* g.gitError(refusal);
  // The same call as the `/diff` route's, with what the page passes it, so the same diff hashes
  // the same.
  const { diff, truncated } = yield* g.fileDiff(repo, {
    path: entry.path,
    origPath: entry.origPath,
    staged: req.action === "unstage",
  });
  if (truncated) return yield* g.gitError(`This diff is too large to stage by lines: ${req.path}`);
  if (diffBase(diff) !== req.base) {
    return yield* g.gitError("This diff changed since it was shown; look at it again");
  }
  const hunks = parseFilePatch(diff);
  if ("error" in hunks) return yield* g.gitError(hunks.error);
  const checked = checkSelection(hunks, req.lines);
  if ("error" in checked) return yield* g.gitError(checked.error);
  if (checked.all) {
    if (req.action === "stage") return yield* g.stage(repo, [entry.path]);
    if (req.action === "unstage") return yield* g.unstage(repo, [entry.path]);
    return yield* g.discard(repo, entry.path);
  }
  const patch = buildPatch(
    hunks,
    entry.path,
    req.lines,
    req.action === "stage" ? "forward" : "reverse",
  );
  if (typeof patch !== "string") return yield* g.gitError(patch.error);
  yield* g.git(
    repo,
    [
      "apply",
      ...(req.action === "discard" ? [] : ["--cached"]),
      ...(req.action === "stage" ? [] : ["--reverse"]),
      // A repo's apply.whitespace could otherwise fix (rewrite) or refuse the lines.
      "--whitespace=nowarn",
      "-",
    ],
    { input: patch },
  );
});
