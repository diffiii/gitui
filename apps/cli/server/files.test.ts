import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as g from "./git.ts";
import { commitFile, git, initRepo, removeTempDirs, testApp, tmpDir, write } from "./test-repo.ts";

afterAll(removeTempDirs);

async function get<T>(repo: string, route: string, params: Record<string, string> = {}) {
  const sp = new URLSearchParams({ repo, ...params });
  const res = await testApp().request(`/api/repo${route}?${sp.toString()}`, {
    headers: { host: "localhost", "x-gitui": "1" },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const listFiles = (repo: string) => get<g.WorkingFiles>(repo, "/files");

/** Every field of a file's body, or of an error, so a test can read whichever came back. */
type FileBody = Partial<{
  size: number;
  content: string;
  symlink: boolean;
  binary: boolean;
  tooLarge: boolean;
  error: string;
}>;
const readFile = (repo: string, file: string) => get<FileBody>(repo, "/file", { path: file });

/** A repo with a commit, an uncommitted edit, an untracked file and an ignored one. */
function workingCopy() {
  const repo = initRepo();
  commitFile(repo, ".gitignore", "*.log\nbuild/\n");
  commitFile(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, "src/a.ts", "export const a = 2;\n");
  write(repo, "notes.md", "# notes\n");
  write(repo, "debug.log", "noise\n");
  write(repo, "build/out.js", "built\n");
  return repo;
}

test("lists tracked and untracked files but not ignored ones", async () => {
  const repo = workingCopy();
  const { status, body } = await listFiles(repo);
  expect(status).toBe(200);
  expect(body.truncated).toBe(false);
  expect([...body.paths].sort()).toEqual([".gitignore", "notes.md", "src/a.ts"]);
});

test("leaves out tracked files deleted from disk and lists a conflicted file once", async () => {
  const repo = initRepo();
  commitFile(repo, "gone.txt", "g\n");
  commitFile(repo, "c.txt", "base\n");
  git(repo, "switch", "-q", "-c", "other");
  commitFile(repo, "c.txt", "other\n");
  git(repo, "switch", "-q", "main");
  commitFile(repo, "c.txt", "main\n");
  expect(() => git(repo, "merge", "-q", "other")).toThrow();
  fs.rmSync(path.join(repo, "gone.txt"));

  const { paths } = await g.workingFiles(repo);
  expect([...paths].sort()).toEqual(["c.txt"]);
});

test("caps the list and says so", async () => {
  const repo = initRepo();
  for (const f of ["a", "b", "c"]) write(repo, f, f);
  expect(await g.workingFiles(repo, 2)).toEqual({
    paths: expect.any(Array),
    truncated: true,
  });
  expect((await g.workingFiles(repo, 2)).paths).toHaveLength(2);
  expect((await g.workingFiles(repo, 3)).truncated).toBe(false);
});

test("reads a file as it is on disk, uncommitted edits included", async () => {
  const repo = workingCopy();
  expect(await readFile(repo, "src/a.ts")).toEqual({
    status: 200,
    body: { size: 20, content: "export const a = 2;\n" },
  });
  expect((await readFile(repo, "notes.md")).body.content).toBe("# notes\n");
});

test("reads paths with spaces and unicode", async () => {
  const repo = initRepo();
  commitFile(repo, "docs/read me.md", "spaced\n");
  write(repo, "zażółć/日本語 ✓.txt", "ünïcödé\n");

  const { body } = await listFiles(repo);
  expect([...body.paths].sort()).toEqual(["docs/read me.md", "zażółć/日本語 ✓.txt"]);
  expect((await readFile(repo, "docs/read me.md")).body.content).toBe("spaced\n");
  expect((await readFile(repo, "zażółć/日本語 ✓.txt")).body.content).toBe("ünïcödé\n");
});

test("refuses a path that isn't one of the listed files", async () => {
  const repo = workingCopy();
  for (const file of ["debug.log", "build/out.js", "src", "missing.txt", ".git/config", "src/*"]) {
    const { status, body } = await readFile(repo, file);
    expect({ file, status }).toEqual({ file, status: 400 });
    expect(body.error).toContain("Not a file in the working copy");
  }
});

test("refuses absolute paths and paths that step up with ..", async () => {
  const repo = workingCopy();
  const outside = path.join(tmpDir(), "secret.txt");
  fs.writeFileSync(outside, "secret\n");
  for (const file of [
    outside,
    path.join(repo, "src/a.ts"),
    "../secret.txt",
    "src/../src/a.ts",
    "src\\..\\notes.md",
    "..",
    "",
  ]) {
    expect(await readFile(repo, file)).toEqual({ status: 400, body: { error: "Invalid path" } });
  }
});

test("shows a symlink's target rather than following it out of the repo", async () => {
  const repo = initRepo();
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "link"));
  fs.symlinkSync("notes.md", path.join(repo, "inner"));
  write(repo, "notes.md", "notes\n");

  const link = await readFile(repo, "link");
  expect(link.status).toBe(200);
  expect(link.body).toMatchObject({ content: path.join(outside, "secret.txt"), symlink: true });
  expect((await readFile(repo, "inner")).body).toEqual({
    size: 8,
    content: "notes.md",
    symlink: true,
  });
});

test("refuses a tracked path whose directory is now a symlink out of the repo", async () => {
  const repo = initRepo();
  commitFile(repo, "dir/secret.txt", "tracked\n");
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.rmSync(path.join(repo, "dir"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "dir"));

  const { status, body } = await readFile(repo, "dir/secret.txt");
  expect(status).toBe(400);
  expect(body.error).not.toContain("secret\n");
});

test("reports binary and too-large files by size", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "image.png"), Buffer.from("89504e470d0a1a0a0000000d", "hex"));
  write(repo, "late-nul.txt", `${"a".repeat(8000)}\0`);
  write(repo, "big.txt", "x".repeat(g.MAX_FILE_BYTES + 1));
  write(repo, "edge.txt", "x".repeat(g.MAX_FILE_BYTES));

  expect((await readFile(repo, "image.png")).body).toEqual({ size: 12, binary: true });
  // Past the first 8000 bytes, as git looks, a NUL doesn't make a file binary.
  expect((await readFile(repo, "late-nul.txt")).body.content).toHaveLength(8001);
  expect((await readFile(repo, "big.txt")).body).toEqual({
    size: g.MAX_FILE_BYTES + 1,
    tooLarge: true,
  });
  expect((await readFile(repo, "edge.txt")).body.size).toBe(g.MAX_FILE_BYTES);
});

test("decodes invalid UTF-8 with replacement characters", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  expect((await readFile(repo, "latin1.txt")).body).toEqual({ size: 5, content: "caf�\n" });
});
