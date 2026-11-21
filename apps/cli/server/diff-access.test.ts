// The untracked-file diff uses `git diff --no-index`, which reads any path it's given; these
// check that the route only ever diffs files git lists as untracked in the repo.
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as files_ from "./files.ts";
import {
  commitFile,
  git,
  initRepo,
  removeTempDirs,
  testApp,
  tmpDir,
  write,
  promised,
} from "./test-repo.ts";

afterAll(removeTempDirs);

const { untrackedDiff: diffUntracked } = promised(files_);

const outside = tmpDir();
fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n");

const repo = initRepo();
commitFile(repo, "tracked.txt", "tracked\n", "init");
write(repo, "new file.txt", "fresh\n");
write(repo, ".gitignore", "ignored.txt\n");
write(repo, "ignored.txt", "ignored\n");
fs.symlinkSync(outside, path.join(repo, "linked"));
// A nested repo, which `ls-files -o` lists as `nested/`; `diff --no-index /dev/null nested/`
// would diff `nested/null`, inside it.
fs.mkdirSync(path.join(repo, "nested"));
const nested = initRepo(path.join(repo, "nested"));
commitFile(nested, "null", "nested secret\n");
git(nested, "config", "remote.origin.url", "https://user:token@example.com/r.git");

async function untrackedDiff(file: string) {
  const res = await testApp().request(
    `/api/repo/diff?${new URLSearchParams({ repo, path: file, untracked: "1", staged: "0" }).toString()}`,
    { headers: { host: "localhost", "x-gitui": "1" } },
  );
  return { status: res.status, body: await res.text() };
}

test("diffs an untracked file of the repo", async () => {
  const { status, body } = await untrackedDiff("new file.txt");
  expect(status).toBe(200);
  expect(body).toContain("+fresh");
});

test("refuses paths outside the repo", async () => {
  for (const file of [
    path.join(outside, "secret.txt"),
    "/etc/hosts",
    path.relative(repo, path.join(outside, "secret.txt")),
    "linked/secret.txt",
  ]) {
    const { status, body } = await untrackedDiff(file);
    expect({ file, status }).toEqual({ file, status: 400 });
    expect(body).not.toContain("top secret");
  }
});

test("refuses ignored, tracked and missing files", async () => {
  for (const file of ["ignored.txt", "tracked.txt", "missing.txt", "*.txt", ":(glob)*"]) {
    expect({ file, status: (await untrackedDiff(file)).status }).toEqual({ file, status: 400 });
  }
});

test("refuses a nested repo's folder and the paths into it", async () => {
  for (const file of ["nested/", "nested", "nested/null", "nested//null", "nested/.git/config"]) {
    const { status, body } = await untrackedDiff(file);
    expect({ file, status }).toEqual({ file, status: 400 });
    expect(body).not.toContain("secret");
    expect(body).not.toContain("token");
  }
  // The diff checks for itself, whoever calls it.
  const err = await diffUntracked(repo, "nested/").catch((e: Error) => e);
  expect((err as Error).message).toBe("Not an untracked file in this repository: nested/");
});
