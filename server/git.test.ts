import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as g from "./git.ts";

// Keep the user's global and system git config (signing, hooks, aliases) out of the tests.
// `git()` in git.ts spawns with process.env, so this applies to it too.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  // realpath: on macOS os.tmpdir() is behind a symlink, and git reports resolved paths.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitui-")));
  dirs.push(d);
  return d;
}

function run(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir = tmpDir()) {
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.name", "Test User");
  run(dir, "config", "user.email", "test@example.com");
  return dir;
}

function bareRepo() {
  const dir = tmpDir();
  run(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

function clone(origin: string) {
  const dir = tmpDir();
  run(dir, "clone", "-q", origin, ".");
  run(dir, "config", "user.name", "Test User");
  run(dir, "config", "user.email", "test@example.com");
  return dir;
}

function write(repo: string, file: string, content: string) {
  const p = path.join(repo, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commitFile(repo: string, file: string, content: string, message = `update ${file}`) {
  write(repo, file, content);
  run(repo, "add", "--", file);
  run(repo, "commit", "-q", "-m", message);
  return head(repo);
}

/** Resolves to the rejection reason, failing if the promise resolves. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e as Error,
  );
}

const head = (repo: string, rev = "HEAD") => run(repo, "rev-parse", rev).trim();
const byPath = (st: g.Status, p: string) => st.files.find((f) => f.path === p);

/** A repo with `main` pushed to a bare `origin` and tracking it. */
function repoWithOrigin() {
  const origin = bareRepo();
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n", "initial");
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "-q", "-u", "origin", "main");
  return { repo, origin };
}

describe("status", () => {
  test("modified unstaged and staged files", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    commitFile(repo, "b.txt", "b\n");
    write(repo, "a.txt", "a2\n");
    write(repo, "b.txt", "b2\n");
    run(repo, "add", "b.txt");

    const st = await g.status(repo);
    expect(st.operation).toBeNull();
    expect(st.head.branch).toBe("main");
    expect(st.head.oid).toBe(head(repo));
    expect(st.head.upstream).toBeNull();
    expect(byPath(st, "a.txt")).toEqual({ x: ".", y: "M", path: "a.txt" });
    expect(byPath(st, "b.txt")).toEqual({ x: "M", y: ".", path: "b.txt" });
  });

  test("untracked files, including nested ones", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    write(repo, "new.txt", "n\n");
    write(repo, "dir/inner.txt", "i\n");

    const st = await g.status(repo);
    expect(byPath(st, "new.txt")).toEqual({ x: ".", y: "?", path: "new.txt", untracked: true });
    expect(byPath(st, "dir/inner.txt")).toEqual({
      x: ".",
      y: "?",
      path: "dir/inner.txt",
      untracked: true,
    });
  });

  test("staged rename has origPath", async () => {
    const repo = initRepo();
    commitFile(repo, "old name.txt", "content that is long enough to be detected\n");
    run(repo, "mv", "old name.txt", "new name.txt");

    const st = await g.status(repo);
    expect(st.files).toEqual([{ x: "R", y: ".", path: "new name.txt", origPath: "old name.txt" }]);
  });

  test("file names with spaces", async () => {
    const repo = initRepo();
    commitFile(repo, "my  file.txt", "a\n");
    write(repo, "my  file.txt", "b\n");
    write(repo, "an untracked file.txt", "c\n");

    const st = await g.status(repo);
    expect(byPath(st, "my  file.txt")).toEqual({ x: ".", y: "M", path: "my  file.txt" });
    expect(byPath(st, "an untracked file.txt")?.untracked).toBe(true);
  });

  test("non-ASCII file names are not quoted", async () => {
    const repo = initRepo();
    commitFile(repo, "zażółć.txt", "a\n");
    write(repo, "zażółć.txt", "b\n");
    write(repo, "日本語.txt", "c\n");

    const st = await g.status(repo);
    expect(byPath(st, "zażółć.txt")).toEqual({ x: ".", y: "M", path: "zażółć.txt" });
    expect(byPath(st, "日本語.txt")?.untracked).toBe(true);
  });

  test("merge conflict", async () => {
    const repo = initRepo();
    commitFile(repo, "f.txt", "base\n");
    run(repo, "switch", "-q", "-c", "other");
    commitFile(repo, "f.txt", "theirs\n");
    run(repo, "switch", "-q", "main");
    commitFile(repo, "f.txt", "ours\n");
    expect(() => run(repo, "merge", "-q", "other")).toThrow();

    const st = await g.status(repo);
    expect(st.operation).toBe("merge");
    expect(st.files).toEqual([{ x: "U", y: "U", path: "f.txt", conflicted: true }]);
  });

  test("detached HEAD", async () => {
    const repo = initRepo();
    const first = commitFile(repo, "a.txt", "1\n");
    commitFile(repo, "a.txt", "2\n");
    run(repo, "switch", "-q", "--detach", first);

    const st = await g.status(repo);
    expect(st.head.branch).toBeNull();
    expect(st.head.oid).toBe(first);
  });

  test("unborn repo", async () => {
    const repo = initRepo();
    write(repo, "a.txt", "a\n");

    const st = await g.status(repo);
    expect(st.head.oid).toBeNull();
    expect(st.head.branch).toBe("main");
    expect(st.files).toEqual([{ x: ".", y: "?", path: "a.txt", untracked: true }]);
  });

  test("ahead/behind upstream", async () => {
    const { repo, origin } = repoWithOrigin();
    const other = clone(origin);
    commitFile(other, "b.txt", "b\n");
    run(other, "push", "-q");
    commitFile(repo, "c.txt", "c\n");
    commitFile(repo, "d.txt", "d\n");
    run(repo, "fetch", "-q");

    const st = await g.status(repo);
    expect(st.head.upstream).toBe("origin/main");
    expect(st.head.ahead).toBe(2);
    expect(st.head.behind).toBe(1);
  });
});

describe("log", () => {
  test("linear history with parents, newest first", async () => {
    const repo = initRepo();
    const c1 = commitFile(repo, "a.txt", "1\n", "one");
    const c2 = commitFile(repo, "a.txt", "2\n", "two");
    const c3 = commitFile(repo, "a.txt", "3\n", "three");

    const commits = await g.log(repo, { limit: 10, all: false });
    expect(commits.map((c) => c.hash)).toEqual([c3, c2, c1]);
    expect(commits.map((c) => c.parents)).toEqual([[c2], [c1], []]);
    expect(commits.map((c) => c.subject)).toEqual(["three", "two", "one"]);
    expect(commits[0].author).toBe("Test User");
    expect(commits[0].email).toBe("test@example.com");
    expect(commits[0].date).toBeGreaterThan(0);
  });

  test("merge commits have two parents", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    run(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "f.txt", "f\n");
    run(repo, "switch", "-q", "main");
    const main = commitFile(repo, "m.txt", "m\n");
    run(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");

    const [merge] = await g.log(repo, { limit: 10, all: false });
    expect(merge.subject).toBe("merge feature");
    expect(merge.parents).toEqual([main, feature]);
  });

  test("refs from %D", async () => {
    const { repo } = repoWithOrigin();
    run(repo, "tag", "v1");
    run(repo, "branch", "other");

    const [c] = await g.log(repo, { limit: 1, all: false });
    expect(c.refs).toContain("HEAD -> refs/heads/main");
    expect(c.refs).toContain("tag: refs/tags/v1");
    expect(c.refs).toContain("refs/remotes/origin/main");
    expect(c.refs).toContain("refs/heads/other");
  });

  test("subjects with unusual characters", async () => {
    const repo = initRepo();
    const subject = `feat(ui)!: a, b | "q" 'q' \`x\` $HOME %s %x1f; & \\ zażółć 日本語 🎉`;
    commitFile(repo, "a.txt", "a\n", subject);
    commitFile(repo, "b.txt", "b\n", "second, with comma\n\nbody line");

    const commits = await g.log(repo, { limit: 10, all: false });
    expect(commits.map((c) => c.subject)).toEqual(["second, with comma", subject]);
  });

  test("all includes other branches", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    run(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "f.txt", "f\n");
    run(repo, "switch", "-q", "main");

    const current = await g.log(repo, { limit: 10, all: false });
    expect(current.map((c) => c.hash)).not.toContain(feature);
    const all = await g.log(repo, { limit: 10, all: true });
    expect(all.map((c) => c.hash)).toContain(feature);
    expect(all).toHaveLength(2);
  });

  test("ref limits the log to that branch", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    run(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "f.txt", "f\n");
    run(repo, "switch", "-q", "main");

    const commits = await g.log(repo, { limit: 10, all: false, ref: "feature" });
    expect(commits[0].hash).toBe(feature);
    expect(commits).toHaveLength(2);
  });

  test("limit is respected", async () => {
    const repo = initRepo();
    for (let i = 0; i < 5; i++) commitFile(repo, "a.txt", `${i}\n`, `c${i}`);

    const commits = await g.log(repo, { limit: 2, all: false });
    expect(commits.map((c) => c.subject)).toEqual(["c4", "c3"]);
  });

  test("unborn repo returns no commits", async () => {
    expect(await g.log(initRepo(), { limit: 10, all: false })).toEqual([]);
  });
});

describe("branches", () => {
  test("current, upstream, ahead/behind, gone, remote", async () => {
    const { repo, origin } = repoWithOrigin();
    // origin/HEAD exists in clones; make it exist here so we can check it is filtered out.
    run(repo, "remote", "set-head", "origin", "main");
    run(repo, "branch", "local-only");
    run(repo, "switch", "-q", "-c", "doomed");
    run(repo, "push", "-q", "-u", "origin", "doomed");
    run(repo, "switch", "-q", "main");
    commitFile(repo, "b.txt", "b\n", "local work");

    // Someone else deletes `doomed` on the remote; fetching with --prune makes it gone.
    const other = clone(origin);
    run(other, "push", "-q", "origin", "--delete", "doomed");
    run(repo, "fetch", "-q", "--prune");

    const list = await g.branches(repo);
    const get = (name: string) => list.find((b) => b.name === name);

    expect(list.map((b) => b.ref)).not.toContain("refs/remotes/origin/HEAD");
    expect(list.filter((b) => b.current).map((b) => b.name)).toEqual(["main"]);

    expect(get("main")).toMatchObject({
      ref: "refs/heads/main",
      remote: false,
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      gone: false,
      current: true,
      subject: "local work",
    });
    expect(head(repo)).toStartWith(get("main")!.hash);

    expect(get("local-only")).toMatchObject({ upstream: null, ahead: 0, behind: 0, gone: false });
    expect(get("doomed")).toMatchObject({ upstream: "origin/doomed", gone: true });
    expect(get("origin/main")).toMatchObject({
      ref: "refs/remotes/origin/main",
      remote: true,
      current: false,
      subject: "initial",
    });
    expect(get("origin/doomed")).toBeUndefined();
  });

  test("behind upstream", async () => {
    const { repo, origin } = repoWithOrigin();
    const other = clone(origin);
    commitFile(other, "b.txt", "b\n");
    commitFile(other, "c.txt", "c\n");
    run(other, "push", "-q");
    run(repo, "fetch", "-q");

    const main = (await g.branches(repo)).find((b) => b.name === "main");
    expect(main).toMatchObject({ ahead: 0, behind: 2 });
  });
});

describe("checkout", () => {
  test("local branch", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    run(repo, "branch", "feature");

    await g.checkout(repo, "feature", false);
    expect((await g.status(repo)).head.branch).toBe("feature");
  });

  test("remote branch creates a tracking branch, then switches to it", async () => {
    const { repo, origin } = repoWithOrigin();
    const other = clone(origin);
    run(other, "switch", "-q", "-c", "feat/x");
    const tip = commitFile(other, "x.txt", "x\n");
    run(other, "push", "-q", "-u", "origin", "feat/x");
    run(repo, "fetch", "-q");

    await g.checkout(repo, "origin/feat/x", true);
    let st = await g.status(repo);
    expect(st.head.branch).toBe("feat/x");
    expect(st.head.upstream).toBe("origin/feat/x");
    expect(st.head.oid).toBe(tip);

    // A second checkout reuses the existing local branch instead of failing.
    run(repo, "switch", "-q", "main");
    commitFile(repo, "local.txt", "l\n");
    run(repo, "switch", "-q", "feat/x");
    const localTip = commitFile(repo, "y.txt", "y\n");
    run(repo, "switch", "-q", "main");

    await g.checkout(repo, "origin/feat/x", true);
    st = await g.status(repo);
    expect(st.head.branch).toBe("feat/x");
    expect(st.head.oid).toBe(localTip);
    expect(st.head.ahead).toBe(1);
  });
});

describe("createBranch / deleteBranch", () => {
  test("create with checkout", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");

    await g.createBranch(repo, "new");
    expect((await g.status(repo)).head.branch).toBe("new");
  });

  test("create without checkout, from a start point", async () => {
    const repo = initRepo();
    const first = commitFile(repo, "a.txt", "1\n");
    commitFile(repo, "a.txt", "2\n");

    await g.createBranch(repo, "old", first, false);
    expect((await g.status(repo)).head.branch).toBe("main");
    expect(head(repo, "old")).toBe(first);
  });

  test("delete an unmerged branch needs force", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    run(repo, "switch", "-q", "-c", "unmerged");
    commitFile(repo, "u.txt", "u\n");
    run(repo, "switch", "-q", "main");

    expect(await rejection(g.deleteBranch(repo, "unmerged", false))).toBeInstanceOf(g.GitError);
    expect((await g.branches(repo)).map((b) => b.name)).toContain("unmerged");

    await g.deleteBranch(repo, "unmerged", true);
    expect((await g.branches(repo)).map((b) => b.name)).not.toContain("unmerged");
  });

  test("delete a merged branch without force", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    run(repo, "branch", "merged");

    await g.deleteBranch(repo, "merged", false);
    expect((await g.branches(repo)).map((b) => b.name)).toEqual(["main"]);
  });
});

describe("commit", () => {
  test("normal commit with a multi-line message", async () => {
    const repo = initRepo();
    write(repo, "a.txt", "a\n");
    run(repo, "add", "a.txt");

    await g.commit(repo, "subject line\n\nbody line", false);
    expect((await g.lastCommitMessage(repo)).trimEnd()).toBe("subject line\n\nbody line");
    expect((await g.status(repo)).files).toEqual([]);
  });

  test("an empty message is rejected", async () => {
    const repo = initRepo();
    write(repo, "a.txt", "a\n");
    run(repo, "add", "a.txt");

    expect(await rejection(g.commit(repo, "", false))).toBeInstanceOf(g.GitError);
  });

  test("amend with a new message", async () => {
    const repo = initRepo();
    const parent = commitFile(repo, "a.txt", "a\n", "first");
    commitFile(repo, "b.txt", "b\n", "old message");
    write(repo, "c.txt", "c\n");
    run(repo, "add", "c.txt");

    await g.commit(repo, "new message", true);
    const commits = await g.log(repo, { limit: 10, all: false });
    expect(commits.map((c) => c.subject)).toEqual(["new message", "first"]);
    expect(commits[0].parents).toEqual([parent]);
    expect(run(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual([
      "b.txt",
      "c.txt",
    ]);
  });

  test("amend with an empty message keeps the old one", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n", "keep me\n\nwith body");
    const before = head(repo);
    write(repo, "b.txt", "b\n");
    run(repo, "add", "b.txt");

    await g.commit(repo, "  \n", true);
    expect(head(repo)).not.toBe(before);
    expect((await g.lastCommitMessage(repo)).trimEnd()).toBe("keep me\n\nwith body");
    expect(await g.log(repo, { limit: 10, all: false })).toHaveLength(1);
  });
});

describe("lastCommitMessage", () => {
  test("unborn repo returns an empty string", async () => {
    expect(await g.lastCommitMessage(initRepo())).toBe("");
  });

  test("returns the full message of HEAD", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n", "one");
    commitFile(repo, "a.txt", "b\n", "two\n\ndetails");
    expect((await g.lastCommitMessage(repo)).trimEnd()).toBe("two\n\ndetails");
  });
});

describe("resolveRepo", () => {
  test("a subdirectory resolves to the top level", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "a/b"), { recursive: true });
    expect(await g.resolveRepo(path.join(repo, "a/b"))).toBe(repo);
    expect(await g.resolveRepo(repo)).toBe(repo);
  });

  test("a file is not a directory", async () => {
    const repo = initRepo();
    write(repo, "file.txt", "x\n");
    expect((await rejection(g.resolveRepo(path.join(repo, "file.txt")))).message).toMatch(
      /Not a directory/,
    );
    expect((await rejection(g.resolveRepo(path.join(repo, "missing")))).message).toMatch(
      /Not a directory/,
    );
  });

  test("a directory outside any repo is rejected", async () => {
    const dir = tmpDir();
    expect((await rejection(g.resolveRepo(dir))).message).toMatch(/Not a git repository/);
  });
});
