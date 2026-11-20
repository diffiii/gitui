import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { fileDiff, git, GitError, showCommit } from "./git.ts";

let repo: string;
let head: string;

const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const lines = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix} line ${i}`).join("\n") + "\n";

/** Parse the way the UI does, but throw on anything malformed (e.g. a hunk-count mismatch). */
const parseStrict = (patch: string) =>
  parsePatchFiles(patch, { throwOnError: true }).flatMap((p) => p.files);

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitui-"));
  sh("init", "-q", "-b", "main");
  sh("config", "user.name", "Test");
  sh("config", "user.email", "test@example.com");
  sh("config", "alias.hang", "!sleep 37.0421");
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), lines(`f${i}`, 100));
  sh("add", ".");
  sh("commit", "-q", "-m", "six files");
  head = sh("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "big.txt"), lines("big", 2000));
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

test("showCommit: small patch is not truncated", async () => {
  const c = await showCommit(repo, head);
  expect(c.truncated).toBe(false);
  expect(parseStrict(c.patch)).toHaveLength(6);
});

test("showCommit: over the cap, trims back to the last complete file", async () => {
  const full = (await showCommit(repo, head)).patch;
  const c = await showCommit(repo, head, { maxBytes: 5000 });
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

test("fileDiff: small diff is not truncated", async () => {
  const d = await fileDiff(repo, { path: "big.txt", staged: false, untracked: true });
  expect(d.truncated).toBe(false);
  expect(parseStrict(d.diff)[0].hunks[0].additionLines).toBe(2000);
});

test("fileDiff: a single oversized hunk is cut to complete lines, and still renders", async () => {
  const d = await fileDiff(repo, {
    path: "big.txt",
    staged: false,
    untracked: true,
    maxBytes: 4000,
  });
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

test("git: timeoutMs kills the child and rejects", async () => {
  const started = Date.now();
  const err = await git(repo, ["hang"], { timeoutMs: 200 }).catch((e) => e);
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toBe("git hang timed out after 0.2 s");
  expect(Date.now() - started).toBeLessThan(5000);
  // git forwards SIGTERM to the alias's shell, so the sleep must be gone too.
  await Bun.sleep(300);
  const ps = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" });
  expect(ps).not.toContain("sleep 37.0421");
});
