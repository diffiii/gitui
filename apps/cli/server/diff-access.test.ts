// The untracked-file diff uses `git diff --no-index`, which reads any path it's given; these
// check that the route only ever diffs files git lists as untracked in the repo.
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { commitFile, initRepo, removeTempDirs, testApp, tmpDir, write } from "./test-repo.ts";

afterAll(removeTempDirs);

const outside = tmpDir();
fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n");

const repo = initRepo();
commitFile(repo, "tracked.txt", "tracked\n", "init");
write(repo, "new file.txt", "fresh\n");
write(repo, ".gitignore", "ignored.txt\n");
write(repo, "ignored.txt", "ignored\n");
fs.symlinkSync(outside, path.join(repo, "linked"));

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
