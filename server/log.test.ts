import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.ts";
import { GitError, log } from "./git.ts";

const dirs: string[] = [];

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitui-"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "commit.gpgsign", "false");
  sh(dir, "config", "tag.gpgsign", "false");
  return dir;
}

function commit(dir: string, message: string) {
  sh(dir, "commit", "-q", "--allow-empty", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("log", () => {
  test("rejects an unknown ref with a GitError", async () => {
    const dir = makeRepo();
    commit(dir, "one");
    const err = await log(dir, { limit: 10, all: false, ref: "refs/heads/nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toBeTruthy();
  });

  test("full refname picks the branch over a tag with the same name", async () => {
    const dir = makeRepo();
    const base = commit(dir, "base");
    sh(dir, "tag", "x");
    const tip = commit(dir, "on x");
    sh(dir, "branch", "x");

    const branch = await log(dir, { limit: 10, all: false, ref: "refs/heads/x" });
    expect(branch.map((c) => c.subject)).toEqual(["on x", "base"]);
    expect(branch[0].hash).toBe(tip);

    // The short name is ambiguous and git resolves it to the tag.
    const tag = await log(dir, { limit: 10, all: false, ref: "x" });
    expect(tag.map((c) => c.hash)).toEqual([base]);
  });

  test("an unborn repo has no commits", async () => {
    const dir = makeRepo();
    expect(await log(dir, { limit: 10, all: true })).toEqual([]);
    expect(await log(dir, { limit: 10, all: false })).toEqual([]);
  });

  test("all: true walks branches and tags", async () => {
    const dir = makeRepo();
    commit(dir, "one");
    sh(dir, "checkout", "-q", "-b", "side");
    commit(dir, "two");
    sh(dir, "checkout", "-q", "main");
    const commits = await log(dir, { limit: 10, all: true });
    expect(commits.map((c) => c.subject).sort()).toEqual(["one", "two"]);
  });
});

describe("GET /api/repo/log", () => {
  test("returns 400 with an error for an unknown ref", async () => {
    const dir = makeRepo();
    commit(dir, "one");
    const q = new URLSearchParams({ repo: dir, ref: "refs/heads/nope" });
    const res = await createApp().request(`/api/repo/log?${q.toString()}`, {
      headers: { host: "localhost", "x-gitui": "1" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns commits for a full refname", async () => {
    const dir = makeRepo();
    commit(dir, "one");
    const q = new URLSearchParams({ repo: dir, ref: "refs/heads/main" });
    const res = await createApp().request(`/api/repo/log?${q.toString()}`, {
      headers: { host: "localhost", "x-gitui": "1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits: { subject: string }[] };
    expect(body.commits.map((c) => c.subject)).toEqual(["one"]);
  });
});
