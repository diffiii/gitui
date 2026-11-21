import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { untrackedDiff } from "./files.ts";
import { git, GitError, gitTimeoutMs, showCommit } from "./git.ts";
import {
  alive,
  git as sh,
  initRepo,
  removeTempDirs,
  revParse,
  run,
  sleeper,
  until,
  write,
} from "./test-repo.ts";

afterAll(removeTempDirs);

let repo: string;
let head: string;
/** What `git hang` starts. */
const hung = sleeper();

const lines = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix} line ${i}`).join("\n") + "\n";

/** Parse the way the UI does, but throw on anything malformed (e.g. a hunk-count mismatch). */
const parseStrict = (patch: string) =>
  parsePatchFiles(patch, { throwOnError: true }).flatMap((p) => p.files);

beforeAll(() => {
  repo = initRepo();
  sh(repo, "config", "alias.hang", `!exec ${hung.command}`);
  for (let i = 0; i < 6; i++) write(repo, `f${i}.txt`, lines(`f${i}`, 100));
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "six files");
  head = revParse(repo);
  write(repo, "big.txt", lines("big", 2000));
});

test("showCommit: small patch is not truncated", async () => {
  const c = await run(showCommit(repo, head));
  expect(c.truncated).toBe(false);
  expect(parseStrict(c.patch)).toHaveLength(6);
});

test("showCommit: over the cap, trims back to the last complete file", async () => {
  const full = (await run(showCommit(repo, head))).patch;
  const c = await run(showCommit(repo, head, { maxBytes: 5000 }));
  expect(c.truncated).toBe(true);
  expect(c.patch.length).toBeGreaterThan(0);
  expect(c.patch.length).toBeLessThanOrEqual(5000);
  // A prefix of the full patch that stops exactly where the next file starts.
  expect(full.startsWith(c.patch)).toBe(true);
  expect(full.slice(c.patch.length).startsWith("diff --git ")).toBe(true);
  const files = parseStrict(c.patch);
  expect(files.length).toBeGreaterThan(0);
  expect(files.length).toBeLessThan(6);
});

test("untrackedDiff: small diff is not truncated", async () => {
  const d = await run(untrackedDiff(repo, "big.txt"));
  expect(d.truncated).toBe(false);
  expect(parseStrict(d.diff)[0].hunks[0].additionLines).toBe(2000);
});

test("untrackedDiff: a single oversized hunk is cut to complete lines, and still renders", async () => {
  const d = await run(untrackedDiff(repo, "big.txt", { maxBytes: 4000 }));
  expect(d.truncated).toBe(true);
  expect(d.diff).toMatch(/\+big line \d+\n$/);
  const kept = d.diff.split("\n").filter((l) => l.startsWith("+big line")).length;
  expect(kept).toBeGreaterThan(0);
  expect(kept).toBeLessThan(2000);
  // The UI's tolerant parse: it warns about the short final hunk, then keeps every line we kept.
  const warn = spyOn(console, "error").mockImplementation(() => {});
  const [file] = parsePatchFiles(d.diff).flatMap((p) => p.files);
  warn.mockRestore();
  expect(file.name).toBe("big.txt");
  expect(file.hunks[0].additionLines).toBe(kept);
});

test("GITUI_GIT_TIMEOUT is in seconds, 0 for none, and 10 minutes otherwise", () => {
  expect(gitTimeoutMs("90")).toBe(90_000);
  expect(gitTimeoutMs("0")).toBeUndefined();
  for (const unset of [undefined, "", " ", "soon", "-1", "Infinity"]) {
    expect(gitTimeoutMs(unset)).toBe(600_000);
  }
});

test("git: timeoutMs kills the child and rejects", async () => {
  const started = Date.now();
  // 2 s, not less: git, its shell and then the runtime must start and write the pid before the
  // kill, and git's shell (MSYS) is slow to start on Windows. A kill that comes too early fails
  // the test at `started()`, rather than leaving it to hang.
  const err = await run(git(repo, ["hang"], { timeoutMs: 2000 })).catch((e) => e);
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toBe("git hang timed out after 2 s (GITUI_GIT_TIMEOUT)");
  expect(Date.now() - started).toBeLessThan(5000);
  const pid = await hung.started();
  expect(await until(() => !alive(pid))).toBe(true);
}, 15_000);
