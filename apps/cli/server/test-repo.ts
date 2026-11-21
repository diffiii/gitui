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
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, type Layer, Scope } from "effect";
import type { HttpRouter } from "effect/http";
import { createApp, toFetch } from "./app.ts";

// An empty file rather than os.devNull, which git for Windows can't open (`\\.\nul`). One fixed
// path, emptied on every run, so nothing is left to clean up.
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), "gitui-test-empty.gitconfig");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** Every test client's scope, closed by `removeTempDirs`. */
const clientScopes: Scope.Closeable[] = [];

/**
 * `layer`'s routes as a web handler (`toFetch`), and `request` for a URL or a path (on
 * http://localhost), as tests send requests. `removeTempDirs` disposes it.
 */
export function client<E>(layer: Layer.Layer<never, E, HttpRouter.HttpRouter>) {
  const scope = Effect.runSync(Scope.make());
  clientScopes.push(scope);
  const fetch = Effect.runSync(Scope.provide(scope)(toFetch(layer)));
  return {
    fetch,
    request: (input: string, init?: RequestInit) =>
      fetch(new Request(new URL(input, "http://localhost").href, init)),
  };
}

/** The app as served locally, with no cross-origin callers, and a recent list of its own. */
export const testApp = () =>
  client(
    createApp({
      listener: { kind: "loopback", allowedOrigins: [], token: "unused" },
      configDir: tmpDir(),
    }),
  );

/** Runs a server Effect with the Node services the server runs with. */
export const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer));

const dirs: string[] = [];

/** Disposes every test client, then deletes every directory `tmpDir()` has created so far. */
export async function removeTempDirs() {
  for (const scope of clientScopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** A fresh empty directory, deleted by `removeTempDirs()`. */
export function tmpDir() {
  // In the form gitui keeps repository paths in (realPath in git.ts): on macOS os.tmpdir() is
  // behind a symlink, and on Windows it can hold a short name (RUNNER~1).
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gitui-")));
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
