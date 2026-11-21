import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { commitFile, git, initRepo, removeTempDirs, testApp, tmpDir, write } from "./test-repo.ts";

afterAll(removeTempDirs);

async function get(repo: string, route: string, params: Record<string, string> = {}) {
  const sp = new URLSearchParams({ repo, ...params });
  const res = await testApp().request(`/api/repo${route}?${sp.toString()}`, {
    headers: { host: "localhost", "x-gitui": "1" },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

/**
 * A file a repo-local command leaves when git runs it (outside the repo, so status ignores it).
 * `ran()` says whether it did, and clears the file for the next check.
 */
function marker() {
  const file = path.join(tmpDir(), "ran");
  return {
    file,
    ran() {
      const exists = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      return exists;
    },
  };
}

/** Calls a route and expects it to answer 200 without having run the marker's command. */
async function expectClean(
  m: ReturnType<typeof marker>,
  repo: string,
  route: string,
  params: Record<string, string> = {},
) {
  const res = await get(repo, route, params);
  // The route in the array names which one failed.
  expect([route, res.status, m.ran()]).toEqual([route, 200, false]);
  return res;
}

test("status, diffs and the file list don't run a repo's core.fsmonitor", async () => {
  const repo = initRepo();
  const m = marker();
  commitFile(repo, "a.txt", "a\n");
  git(repo, "config", "core.fsmonitor", `touch '${m.file}'; true`);
  write(repo, "a.txt", "b\n");

  git(repo, "status", "--porcelain=v2");
  expect(m.ran()).toBe(true);

  await expectClean(m, repo, "/status");
  await expectClean(m, repo, "/diff", { path: "a.txt", staged: "0", untracked: "0" });
  await expectClean(m, repo, "/files");
});

test("diffs don't run a repo's textconv driver", async () => {
  const repo = initRepo();
  const m = marker();
  commitFile(repo, ".gitattributes", "*.dat diff=tc\n");
  git(repo, "config", "diff.tc.textconv", `sh -c 'touch "${m.file}"; cat "$0"'`);
  commitFile(repo, "b.dat", "one\n");
  const hash = commitFile(repo, "b.dat", "two\n");
  write(repo, "b.dat", "three\n");
  write(repo, "new.dat", "u\n");

  git(repo, "diff");
  expect(m.ran()).toBe(true);

  const first = await expectClean(m, repo, "/diff", {
    path: "b.dat",
    staged: "0",
    untracked: "0",
  });
  expect(JSON.stringify(first.body)).toContain("+three");
  await expectClean(m, repo, `/commit/${hash}`);
  await expectClean(m, repo, "/diff", { path: "new.dat", staged: "0", untracked: "1" });
  git(repo, "add", "b.dat");
  await expectClean(m, repo, "/diff", { path: "b.dat", staged: "1", untracked: "0" });
});

test("an untracked file's diff doesn't run diff.external", async () => {
  const repo = initRepo();
  const m = marker();
  commitFile(repo, "a.txt", "a\n");
  git(repo, "config", "diff.external", `sh -c 'touch "${m.file}"'`);
  write(repo, "new.txt", "u\n");

  try {
    git(repo, "diff", "--no-index", "--", "/dev/null", "new.txt");
  } catch {
    // Exit 1 means it found differences.
  }
  expect(m.ran()).toBe(true);

  await expectClean(m, repo, "/diff", { path: "new.txt", staged: "0", untracked: "1" });
});
