import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as g from "./git.ts";
import {
  clone,
  commitFile,
  git,
  initRepo,
  run,
  removeTempDirs,
  repoWithOrigin,
  revParse,
  tmpDir,
  write,
} from "./test-repo.ts";

afterAll(removeTempDirs);

const byPath = (st: g.Status, p: string) => st.files.find((f) => f.path === p);

/** Resolves to the rejection reason, failing if the promise resolves. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e as Error,
  );
}

describe("status", () => {
  test("modified unstaged and staged files", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    commitFile(repo, "b.txt", "b\n");
    write(repo, "a.txt", "a2\n");
    write(repo, "b.txt", "b2\n");
    git(repo, "add", "b.txt");

    const st = await run(g.status(repo));
    expect(st.operation).toBeNull();
    expect(st.head.branch).toBe("main");
    expect(st.head.oid).toBe(revParse(repo));
    expect(st.head.upstream).toBeNull();
    expect(byPath(st, "a.txt")).toEqual({ x: ".", y: "M", path: "a.txt" });
    expect(byPath(st, "b.txt")).toEqual({ x: "M", y: ".", path: "b.txt" });
  });

  test("untracked files, including nested ones", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    write(repo, "new.txt", "n\n");
    write(repo, "dir/inner.txt", "i\n");

    const st = await run(g.status(repo));
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
    git(repo, "mv", "old name.txt", "new name.txt");

    const st = await run(g.status(repo));
    expect(st.files).toEqual([{ x: "R", y: ".", path: "new name.txt", origPath: "old name.txt" }]);
  });

  test("file names with spaces", async () => {
    const repo = initRepo();
    commitFile(repo, "my  file.txt", "a\n");
    write(repo, "my  file.txt", "b\n");
    write(repo, "an untracked file.txt", "c\n");

    const st = await run(g.status(repo));
    expect(byPath(st, "my  file.txt")).toEqual({ x: ".", y: "M", path: "my  file.txt" });
    expect(byPath(st, "an untracked file.txt")?.untracked).toBe(true);
  });

  test("non-ASCII file names are not quoted", async () => {
    const repo = initRepo();
    commitFile(repo, "zażółć.txt", "a\n");
    write(repo, "zażółć.txt", "b\n");
    write(repo, "日本語.txt", "c\n");

    const st = await run(g.status(repo));
    expect(byPath(st, "zażółć.txt")).toEqual({ x: ".", y: "M", path: "zażółć.txt" });
    expect(byPath(st, "日本語.txt")?.untracked).toBe(true);
  });

  test("merge conflict", async () => {
    const repo = initRepo();
    commitFile(repo, "f.txt", "base\n");
    git(repo, "switch", "-q", "-c", "other");
    commitFile(repo, "f.txt", "theirs\n");
    git(repo, "switch", "-q", "main");
    commitFile(repo, "f.txt", "ours\n");
    expect(() => git(repo, "merge", "-q", "other")).toThrow();

    const st = await run(g.status(repo));
    expect(st.operation).toBe("merge");
    expect(st.files).toEqual([{ x: "U", y: "U", path: "f.txt", conflicted: true }]);
  });

  test("detached HEAD", async () => {
    const repo = initRepo();
    const first = commitFile(repo, "a.txt", "1\n");
    commitFile(repo, "a.txt", "2\n");
    git(repo, "switch", "-q", "--detach", first);

    const st = await run(g.status(repo));
    expect(st.head.branch).toBeNull();
    expect(st.head.oid).toBe(first);
  });

  test("unborn repo", async () => {
    const repo = initRepo();
    write(repo, "a.txt", "a\n");

    const st = await run(g.status(repo));
    expect(st.head.oid).toBeNull();
    expect(st.head.branch).toBe("main");
    expect(st.files).toEqual([{ x: ".", y: "?", path: "a.txt", untracked: true }]);
  });

  test("ahead/behind upstream", async () => {
    const { repo, origin } = repoWithOrigin();
    const other = clone(origin);
    commitFile(other, "b.txt", "b\n");
    git(other, "push", "-q");
    commitFile(repo, "c.txt", "c\n");
    commitFile(repo, "d.txt", "d\n");
    git(repo, "fetch", "-q");

    const st = await run(g.status(repo));
    expect(st.head.upstream).toBe("origin/main");
    expect(st.head.ahead).toBe(2);
    expect(st.head.behind).toBe(1);
  });

  test("a submodule and a nested repository are flagged as repositories", async () => {
    const repo = initRepo();
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub);
    initRepo(sub);
    commitFile(sub, "f", "1\n");
    git(repo, "add", "sub");
    git(repo, "commit", "-q", "-m", "sub");
    write(sub, "f", "2\n");
    const nested = path.join(repo, "nested");
    fs.mkdirSync(nested);
    initRepo(nested);
    write(nested, "n.txt", "n\n");

    const st = await run(g.status(repo));
    expect(byPath(st, "sub")?.repository).toBe(true);
    expect(byPath(st, "nested/")?.repository).toBe(true);
    expect(st.truncated).toBe(false);
  });

  describe("parseStatus", () => {
    const raw =
      "# branch.oid abc\0# branch.head main\0" +
      "1 .M N... 100644 100644 100644 h1 h2 a.txt\0" +
      "2 R. N... 100644 100644 100644 h1 h2 R100 new.txt\0old.txt\0" +
      "? z.txt\0";

    test("parses every kind", () => {
      const { head, files } = g.parseStatus(raw);
      expect(head.branch).toBe("main");
      expect(files).toEqual([
        { x: ".", y: "M", path: "a.txt" },
        { x: "R", y: ".", path: "new.txt", origPath: "old.txt" },
        { x: ".", y: "?", path: "z.txt", untracked: true },
      ]);
    });

    test("every cut of the output yields only whole entries", () => {
      for (let n = 0; n <= raw.length; n++) {
        for (const f of g.parseStatus(raw.slice(0, n)).files) {
          if (f.x === "R") expect(f.origPath).toBe("old.txt");
          expect(["a.txt", "new.txt", "z.txt"]).toContain(f.path);
        }
      }
    });
  });
});

test("gitSubcommand names the subcommand after any -c pairs", () => {
  expect(g.gitSubcommand(["diff", "--cached"])).toBe("diff");
  expect(g.gitSubcommand(["-c", "diff.suppressBlankEmpty=false", "diff", "-U3"])).toBe("diff");
  expect(g.gitSubcommand(["-c", "a=b", "-c", "c=d", "apply", "-"])).toBe("apply");
});

describe("discardCommand", () => {
  const entry = (e: Partial<g.FileStatus>): g.FileStatus => ({ x: ".", y: "M", path: "f", ...e });
  const lit = (...p: string[]) => ["--", ...p.map((x) => `:(literal)${x}`)];

  test("restores the work tree file", () => {
    expect(g.discardCommand(entry({}))).toEqual(["restore", "--worktree", ...lit("f")]);
    expect(g.discardCommand(entry({ x: "R", origPath: "o" }))).toEqual([
      "restore",
      "--worktree",
      ...lit("f"),
    ]);
  });
  test("a work tree rename restores both sides", () => {
    expect(g.discardCommand(entry({ y: "R", origPath: "o" }))).toEqual([
      "restore",
      "--worktree",
      ...lit("o", "f"),
    ]);
  });
  test("cleans an untracked file", () => {
    expect(g.discardCommand(entry({ y: "?", untracked: true }))).toEqual([
      "clean",
      "-f",
      "-q",
      ...lit("f"),
    ]);
  });
  test.each([
    entry({ repository: true }),
    entry({ y: "?", untracked: true, repository: true }),
    entry({ x: "U", y: "U", conflicted: true }),
    entry({ x: "M", y: "." }),
  ])("refuses %o", (e) => {
    expect(typeof g.discardCommand(e)).toBe("string");
  });
});

describe("log", () => {
  test("linear history with parents, newest first", async () => {
    const repo = initRepo();
    const c1 = commitFile(repo, "a.txt", "1\n", "one");
    const c2 = commitFile(repo, "a.txt", "2\n", "two");
    const c3 = commitFile(repo, "a.txt", "3\n", "three");

    const commits = await run(g.log(repo, { limit: 10, all: false }));
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
    git(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "f.txt", "f\n");
    git(repo, "switch", "-q", "main");
    const main = commitFile(repo, "m.txt", "m\n");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");

    const [merge] = await run(g.log(repo, { limit: 10, all: false }));
    expect(merge.subject).toBe("merge feature");
    expect(merge.parents).toEqual([main, feature]);
  });

  test("refs from %D", async () => {
    const { repo } = repoWithOrigin();
    git(repo, "tag", "v1");
    git(repo, "branch", "other");

    const [c] = await run(g.log(repo, { limit: 1, all: false }));
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

    const commits = await run(g.log(repo, { limit: 10, all: false }));
    expect(commits.map((c) => c.subject)).toEqual(["second, with comma", subject]);
  });

  test("all includes other branches", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    git(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "f.txt", "f\n");
    git(repo, "switch", "-q", "main");

    const current = await run(g.log(repo, { limit: 10, all: false }));
    expect(current.map((c) => c.hash)).not.toContain(feature);
    const all = await run(g.log(repo, { limit: 10, all: true }));
    expect(all.map((c) => c.hash)).toContain(feature);
    expect(all).toHaveLength(2);
  });

  test("ref limits the log to that branch", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    git(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "f.txt", "f\n");
    git(repo, "switch", "-q", "main");

    const commits = await run(g.log(repo, { limit: 10, all: false, ref: "feature" }));
    expect(commits[0].hash).toBe(feature);
    expect(commits).toHaveLength(2);
  });

  test("limit is respected", async () => {
    const repo = initRepo();
    for (let i = 0; i < 5; i++) commitFile(repo, "a.txt", `${i}\n`, `c${i}`);

    const commits = await run(g.log(repo, { limit: 2, all: false }));
    expect(commits.map((c) => c.subject)).toEqual(["c4", "c3"]);
  });

  test("unborn repo returns no commits", async () => {
    expect(await run(g.log(initRepo(), { limit: 10, all: false }))).toEqual([]);
  });
});

describe("branches", () => {
  test("current, upstream, ahead/behind, gone, remote", async () => {
    const { repo, origin } = repoWithOrigin();
    // origin/HEAD exists in clones; make it exist here so we can check it is filtered out.
    git(repo, "remote", "set-head", "origin", "main");
    git(repo, "branch", "local-only");
    git(repo, "switch", "-q", "-c", "doomed");
    git(repo, "push", "-q", "-u", "origin", "doomed");
    git(repo, "switch", "-q", "main");
    commitFile(repo, "b.txt", "b\n", "local work");

    // Someone else deletes `doomed` on the remote; fetching with --prune makes it gone.
    const other = clone(origin);
    git(other, "push", "-q", "origin", "--delete", "doomed");
    git(repo, "fetch", "-q", "--prune");

    const list = await run(g.branches(repo));
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
    expect(revParse(repo)).toStartWith(get("main")!.hash);

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
    git(other, "push", "-q");
    git(repo, "fetch", "-q");

    const main = (await run(g.branches(repo))).find((b) => b.name === "main");
    expect(main).toMatchObject({ ahead: 0, behind: 2 });
  });
});

describe("checkout", () => {
  test("local branch", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    git(repo, "branch", "feature");

    await run(g.checkout(repo, "feature", false));
    expect((await run(g.status(repo))).head.branch).toBe("feature");
  });

  test("remote branch creates a tracking branch, then switches to it", async () => {
    const { repo, origin } = repoWithOrigin();
    const other = clone(origin);
    git(other, "switch", "-q", "-c", "feat/x");
    const tip = commitFile(other, "x.txt", "x\n");
    git(other, "push", "-q", "-u", "origin", "feat/x");
    git(repo, "fetch", "-q");

    await run(g.checkout(repo, "origin/feat/x", true));
    let st = await run(g.status(repo));
    expect(st.head.branch).toBe("feat/x");
    expect(st.head.upstream).toBe("origin/feat/x");
    expect(st.head.oid).toBe(tip);

    // A second checkout reuses the existing local branch instead of failing.
    const localTip = commitFile(repo, "y.txt", "y\n");
    git(repo, "switch", "-q", "main");

    await run(g.checkout(repo, "origin/feat/x", true));
    st = await run(g.status(repo));
    expect(st.head.branch).toBe("feat/x");
    expect(st.head.oid).toBe(localTip);
    expect(st.head.ahead).toBe(1);
  });
});

describe("createBranch / deleteBranch", () => {
  test("create with checkout", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");

    await run(g.createBranch(repo, "new"));
    expect((await run(g.status(repo))).head.branch).toBe("new");
  });

  test("create without checkout, from a start point", async () => {
    const repo = initRepo();
    const first = commitFile(repo, "a.txt", "1\n");
    commitFile(repo, "a.txt", "2\n");

    await run(g.createBranch(repo, "old", first, false));
    expect((await run(g.status(repo))).head.branch).toBe("main");
    expect(revParse(repo, "old")).toBe(first);
  });

  test("delete an unmerged branch needs force", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    git(repo, "switch", "-q", "-c", "unmerged");
    commitFile(repo, "u.txt", "u\n");
    git(repo, "switch", "-q", "main");

    expect(await rejection(run(g.deleteBranch(repo, "unmerged", false)))).toBeInstanceOf(
      g.GitError,
    );
    expect((await run(g.branches(repo))).map((b) => b.name)).toContain("unmerged");

    await run(g.deleteBranch(repo, "unmerged", true));
    expect((await run(g.branches(repo))).map((b) => b.name)).not.toContain("unmerged");
  });

  test("delete a merged branch without force", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    git(repo, "branch", "merged");

    await run(g.deleteBranch(repo, "merged", false));
    expect((await run(g.branches(repo))).map((b) => b.name)).toEqual(["main"]);
  });
});

describe("commit", () => {
  test("normal commit with a multi-line message", async () => {
    const repo = initRepo();
    write(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");

    await run(g.commit(repo, "subject line\n\nbody line", false));
    expect((await run(g.lastCommitMessage(repo))).trimEnd()).toBe("subject line\n\nbody line");
    expect((await run(g.status(repo))).files).toEqual([]);
  });

  test("an empty message is rejected", async () => {
    const repo = initRepo();
    write(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");

    expect(await rejection(run(g.commit(repo, "", false)))).toBeInstanceOf(g.GitError);
  });

  test("amend with a new message", async () => {
    const repo = initRepo();
    const parent = commitFile(repo, "a.txt", "a\n", "first");
    commitFile(repo, "b.txt", "b\n", "old message");
    write(repo, "c.txt", "c\n");
    git(repo, "add", "c.txt");

    await run(g.commit(repo, "new message", true));
    const commits = await run(g.log(repo, { limit: 10, all: false }));
    expect(commits.map((c) => c.subject)).toEqual(["new message", "first"]);
    expect(commits[0].parents).toEqual([parent]);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual([
      "b.txt",
      "c.txt",
    ]);
  });

  test("amend with an empty message keeps the old one", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n", "keep me\n\nwith body");
    const before = revParse(repo);
    write(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");

    await run(g.commit(repo, "  \n", true));
    expect(revParse(repo)).not.toBe(before);
    expect((await run(g.lastCommitMessage(repo))).trimEnd()).toBe("keep me\n\nwith body");
    expect(await run(g.log(repo, { limit: 10, all: false }))).toHaveLength(1);
  });

  test("a hook flooding stderr fails with only the start of it", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    fs.writeFileSync(
      path.join(repo, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nhead -c 4000000 /dev/zero | tr '\\0' x >&2\nexit 1\n",
      { mode: 0o755 },
    );
    write(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");

    const err = (await rejection(run(g.commit(repo, "nope", false)))) as g.GitError;
    expect(err).toBeInstanceOf(g.GitError);
    expect(err.message).toMatch(/^x+$/);
    expect(err.message.length).toBe(64 * 1024);
  });
});

describe("lastCommitMessage", () => {
  test("unborn repo returns an empty string", async () => {
    expect(await run(g.lastCommitMessage(initRepo()))).toBe("");
  });

  test("returns the full message of HEAD", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n", "one");
    commitFile(repo, "a.txt", "b\n", "two\n\ndetails");
    expect((await run(g.lastCommitMessage(repo))).trimEnd()).toBe("two\n\ndetails");
  });
});

describe("resolveRepo", () => {
  test("a subdirectory resolves to the top level", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "a/b"), { recursive: true });
    expect(await run(g.resolveRepo(path.join(repo, "a/b")))).toBe(repo);
    expect(await run(g.resolveRepo(repo))).toBe(repo);
  });

  test("a file or a missing path is not a directory", async () => {
    const repo = initRepo();
    write(repo, "file.txt", "x\n");
    expect((await rejection(run(g.resolveRepo(path.join(repo, "file.txt"))))).message).toMatch(
      /Not a directory/,
    );
    expect((await rejection(run(g.resolveRepo(path.join(repo, "missing"))))).message).toMatch(
      /Not a directory/,
    );
  });

  test("a directory outside any repo is rejected", async () => {
    expect((await rejection(run(g.resolveRepo(tmpDir())))).message).toMatch(/Not a git repository/);
  });
});
