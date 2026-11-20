// Temp-repo fixtures for server tests. Importing this module also isolates every git process
// in the test run from the user's global and system config (signing, hooks, aliases, default
// branch): `git()` in git.ts spawns with process.env, so the server code under test gets it too.
//
// Each test file must call `afterAll(removeTempDirs)`. Bun evaluates this module once per run,
// so a hook registered here would only fire for the first file that imports it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.ts";

process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** The app as served locally, with no cross-origin callers. */
export const testApp = () => createApp({ allowedOrigins: [], token: "unused" });

const dirs: string[] = [];

/** Deletes every directory `tmpDir()` has created so far. */
export function removeTempDirs() {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** A fresh empty directory, deleted by `removeTempDirs()`. */
export function tmpDir() {
  // realpath: on macOS os.tmpdir() is behind a symlink, and git reports resolved paths.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitui-")));
  dirs.push(d);
  return d;
}

/** Runs git synchronously for test setup and returns stdout; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setIdentity(repo: string) {
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  return repo;
}

/** An empty repo on an unborn `main`, with a committer identity. */
export function initRepo(dir = tmpDir()) {
  git(dir, "init", "-q", "-b", "main");
  return setIdentity(dir);
}

export function bareRepo() {
  const dir = tmpDir();
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

export function clone(origin: string) {
  const dir = tmpDir();
  git(dir, "clone", "-q", origin, ".");
  return setIdentity(dir);
}

/** A repo with one commit on `main`, pushed to a bare `origin` and tracking it. */
export function repoWithOrigin() {
  const origin = bareRepo();
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n", "initial");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, origin };
}

/** Writes a file in the work tree, creating parent directories. */
export function write(repo: string, file: string, content: string) {
  const p = path.join(repo, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Writes, stages and commits one file; returns the new HEAD hash. */
export function commitFile(
  repo: string,
  file: string,
  content: string,
  message = `update ${file}`,
) {
  write(repo, file, content);
  git(repo, "add", "--", file);
  git(repo, "commit", "-q", "-m", message);
  return revParse(repo);
}

export function revParse(repo: string, rev = "HEAD") {
  return git(repo, "rev-parse", rev).trim();
}
