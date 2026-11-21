import { afterAll, describe, expect, test } from "bun:test";
import { GitError, log } from "./git.ts";
import { git, initRepo, removeTempDirs, revParse, testApp, run } from "./test-repo.ts";

afterAll(removeTempDirs);

function commit(dir: string, message: string) {
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return revParse(dir);
}

describe("log", () => {
  test("rejects an unknown ref with a GitError", async () => {
    const dir = initRepo();
    commit(dir, "one");
    const err = await run(log(dir, { limit: 10, all: false, ref: "refs/heads/nope" })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GitError);
  });

  test("full refname picks the branch over a tag with the same name", async () => {
    const dir = initRepo();
    const base = commit(dir, "base");
    git(dir, "tag", "x");
    const tip = commit(dir, "on x");
    git(dir, "branch", "x");

    const branch = await run(log(dir, { limit: 10, all: false, ref: "refs/heads/x" }));
    expect(branch.map((c) => c.subject)).toEqual(["on x", "base"]);
    expect(branch[0].hash).toBe(tip);

    // The short name is ambiguous and git resolves it to the tag.
    const tag = await run(log(dir, { limit: 10, all: false, ref: "x" }));
    expect(tag.map((c) => c.hash)).toEqual([base]);
  });

  test("an unborn repo has no commits", async () => {
    const dir = initRepo();
    expect(await run(log(dir, { limit: 10, all: true }))).toEqual([]);
    expect(await run(log(dir, { limit: 10, all: false }))).toEqual([]);
  });

  test("all: true in an unborn repo still walks fetched remote branches", async () => {
    const upstream = initRepo();
    commit(upstream, "upstream");
    const dir = initRepo();
    git(dir, "fetch", "-q", upstream, "main:refs/remotes/origin/main");
    expect((await run(log(dir, { limit: 10, all: true }))).map((c) => c.subject)).toEqual([
      "upstream",
    ]);
    expect(await run(log(dir, { limit: 10, all: false }))).toEqual([]);
  });

  test("all: true walks branches and tags", async () => {
    const dir = initRepo();
    commit(dir, "one");
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, "two");
    git(dir, "checkout", "-q", "main");
    const commits = await run(log(dir, { limit: 10, all: true }));
    expect(commits.map((c) => c.subject).sort()).toEqual(["one", "two"]);
  });
});

function getLog(params: Record<string, string>) {
  return testApp().request(`/api/repo/log?${new URLSearchParams(params).toString()}`, {
    headers: { host: "localhost", "x-gitui": "1" },
  });
}

describe("GET /api/repo/log", () => {
  test("returns 400 with an error for an unknown ref", async () => {
    const dir = initRepo();
    commit(dir, "one");
    const res = await getLog({ repo: dir, ref: "refs/heads/nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns commits for a full refname", async () => {
    const dir = initRepo();
    commit(dir, "one");
    const res = await getLog({ repo: dir, ref: "refs/heads/main" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits: { subject: string }[] };
    expect(body.commits.map((c) => c.subject)).toEqual(["one"]);
  });
});
