import { afterAll, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { open } from "node:fs/promises";
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

const g = promised(files_);

async function get<T>(repo: string, route: string, params: Record<string, string> = {}) {
  const sp = new URLSearchParams({ repo, ...params });
  const res = await testApp().request(`/api/repo${route}?${sp.toString()}`, {
    headers: { host: "localhost", "x-gitui": "1" },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const listFiles = (repo: string) => get<files_.WorkingFiles>(repo, "/files");

/** Every field of a file's body, or of an error, so a test can read whichever came back. */
type FileBody = Partial<{
  kind: files_.WorkingFile["kind"];
  size: number;
  content: string;
  target: string;
  error: string;
}>;
const readFile = (repo: string, file: string) => get<FileBody>(repo, "/file", { path: file });

const refused = (error: string) => ({ status: 400, body: { error } });

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
    body: { kind: "text", size: 20, content: "export const a = 2;\n" },
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
    expect({ file, status, error: body.error }).toEqual({
      file,
      status: 400,
      error: `Not a file in the working copy: ${file}`,
    });
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

  expect(await readFile(repo, "link")).toEqual({
    status: 200,
    body: { kind: "symlink", target: path.join(outside, "secret.txt") },
  });
  expect((await readFile(repo, "inner")).body).toEqual({ kind: "symlink", target: "notes.md" });
});

test("refuses a tracked path whose directory is now a symlink out of the repo", async () => {
  const repo = initRepo();
  commitFile(repo, "dir/secret.txt", "tracked\n");
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.rmSync(path.join(repo, "dir"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "dir"));

  expect(await readFile(repo, "dir/secret.txt")).toEqual(
    refused("Behind a symbolic link: dir/secret.txt"),
  );
});

test("refuses a tracked path whose directory is now a symlink to .git", async () => {
  const repo = initRepo();
  commitFile(repo, "x/config", "tracked\n");
  git(repo, "config", "remote.origin.url", "https://user:token@example.com/r.git");
  fs.rmSync(path.join(repo, "x"), { recursive: true });
  fs.symlinkSync(".git", path.join(repo, "x"));

  expect(await readFile(repo, "x/config")).toEqual(refused("Behind a symbolic link: x/config"));
  // Listed as the symlink it now is, not as a folder too, which the tree can't show.
  expect((await listFiles(repo)).body.paths).toEqual(["x"]);
});

test("refuses a symlinked directory even when it points inside the repo", async () => {
  const repo = initRepo();
  commitFile(repo, "real/a.txt", "a\n");
  commitFile(repo, "x/a.txt", "x\n");
  fs.rmSync(path.join(repo, "x"), { recursive: true });
  fs.symlinkSync("real", path.join(repo, "x"));

  expect(await readFile(repo, "x/a.txt")).toEqual(refused("Behind a symbolic link: x/a.txt"));
  expect((await readFile(repo, "real/a.txt")).body.content).toBe("a\n");
});

test("refuses paths into .git, the repo's or a nested repo's", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n");
  fs.mkdirSync(path.join(repo, "nested"));
  const nested = initRepo(path.join(repo, "nested"));
  commitFile(nested, "b.txt", "b\n");

  expect((await listFiles(repo)).body.paths).toEqual(["a.txt"]);
  for (const file of [".git/config", "nested/.git/config", "nested/.GIT/HEAD", "nested/b.txt"]) {
    expect(await readFile(repo, file)).toEqual(refused(`Not a file in the working copy: ${file}`));
  }
});

/** A repo whose git directory is `meta/`, inside its own work tree, holding a credential. */
function separateGitDir() {
  const repo = tmpDir();
  git(repo, "init", "-q", "-b", "main", "--separate-git-dir", path.join(repo, "meta"));
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "remote.origin.url", "https://user:token@example.com/r.git");
  commitFile(repo, "a.txt", "a\n");
  return repo;
}

test("leaves out a git directory in the work tree under another name, and refuses its files", async () => {
  const repo = separateGitDir();
  // Git itself lists them as untracked.
  expect(git(repo, "ls-files", "-o", "--exclude-standard")).toContain("meta/config");

  expect((await listFiles(repo)).body.paths).toEqual(["a.txt"]);
  expect(await readFile(repo, "meta/config")).toEqual(
    refused("Inside a git directory: meta/config"),
  );
  expect((await readFile(repo, "a.txt")).body.content).toBe("a\n");
});

test("a work tree that is its own git directory exposes nothing of it", async () => {
  const repo = tmpDir();
  git(repo, "init", "-q", "--bare", "-b", "main", ".");
  git(repo, "config", "core.bare", "false");
  git(repo, "config", "core.worktree", ".");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "remote.origin.url", "https://user:token@example.com/r.git");
  commitFile(repo, "a.txt", "a\n");
  expect(git(repo, "ls-files", "-o", "--exclude-standard")).toContain("config");

  expect((await listFiles(repo)).body.paths).toEqual([]);
  expect(await readFile(repo, "config")).toEqual(refused("Inside a git directory: config"));
  const diff = await get(repo, "/diff", { path: "config", untracked: "1", staged: "0" });
  expect(diff.status).toBe(400);
  expect(JSON.stringify(diff.body)).not.toContain("token");
});

test("refuses a case variant of a git directory's path", async () => {
  const repo = separateGitDir();
  for (const file of ["META/config", "Meta/HEAD"]) {
    const { status, body } = await readFile(repo, file);
    expect({ file, status }).toEqual({ file, status: 400 });
    expect(JSON.stringify(body)).not.toContain("token");
  }
});

test("leaves out a bare repo in the work tree, and refuses its files", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n");
  git(repo, "init", "-q", "--bare", "backup.git");
  git(path.join(repo, "backup.git"), "config", "remote.origin.url", "https://u:token@x/r.git");
  expect(git(repo, "ls-files", "-o", "--exclude-standard")).toContain("backup.git/config");

  expect((await listFiles(repo)).body.paths).toEqual(["a.txt"]);
  for (const file of ["backup.git/config", "backup.git/HEAD"]) {
    expect(await readFile(repo, file)).toEqual(refused(`Inside a git directory: ${file}`));
  }
});

test("refuses a nested repo's folder, which git lists as `nested/`", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n");
  fs.mkdirSync(path.join(repo, "nested"));
  const nested = initRepo(path.join(repo, "nested"));
  commitFile(nested, "b.txt", "b\n");
  expect(git(repo, "ls-files", "-o", "--exclude-standard")).toBe("nested/\n");

  for (const file of ["nested/", "nested//b.txt"]) {
    expect(await readFile(repo, file)).toEqual({ status: 400, body: { error: "Invalid path" } });
  }
  // The reader checks for itself, whoever calls it.
  for (const file of ["nested/", "nested//b.txt", "./a.txt", "/a.txt"]) {
    const err = await g.workingFile(repo, file).catch((e: Error) => e);
    expect({ file, error: (err as Error).message }).toEqual({
      file,
      error: `Not a file in the working copy: ${file}`,
    });
  }
});

test("leaves out a tracked path behind an ignored symlink to .git", async () => {
  const repo = initRepo();
  commitFile(repo, "x/config", "tracked\n");
  commitFile(repo, ".gitignore", "/x\n");
  git(repo, "config", "remote.origin.url", "https://user:token@example.com/r.git");
  fs.rmSync(path.join(repo, "x"), { recursive: true });
  fs.symlinkSync(".git", path.join(repo, "x"));
  // Still listed by git, through the symlink.
  expect(git(repo, "ls-files", "--cached", "--deleted")).toContain("x/config");

  expect((await listFiles(repo)).body.paths).toEqual([".gitignore"]);
  expect(await readFile(repo, "x/config")).toEqual(refused("Behind a symbolic link: x/config"));
});

test("lists a skip-worktree file while it's on disk", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n");
  commitFile(repo, "dir/b.txt", "b\n");
  git(repo, "update-index", "--skip-worktree", "dir/b.txt");
  expect(git(repo, "ls-files", "-t", "dir/b.txt")).toBe("S dir/b.txt\n");

  expect([...(await listFiles(repo)).body.paths].sort()).toEqual(["a.txt", "dir/b.txt"]);
  expect((await readFile(repo, "dir/b.txt")).body.content).toBe("b\n");

  fs.rmSync(path.join(repo, "dir"), { recursive: true });
  expect((await listFiles(repo)).body.paths).toEqual(["a.txt"]);
  expect(await readFile(repo, "dir/b.txt")).toEqual(
    refused("Not a file in the working copy: dir/b.txt"),
  );
});

test("refuses a tracked file swapped for a FIFO without blocking", async () => {
  if (process.platform === "win32") return;
  const repo = initRepo();
  commitFile(repo, "pipe", "was a file\n");
  fs.rmSync(path.join(repo, "pipe"));
  execFileSync("mkfifo", [path.join(repo, "pipe")]);

  expect(await readFile(repo, "pipe")).toEqual(refused("Not a regular file: pipe"));
});

test("leaves out the paths a sparse checkout doesn't check out", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n");
  commitFile(repo, "out/b.txt", "b\n");
  git(repo, "sparse-checkout", "set", "--no-cone", "/*", "!/out/");
  expect(fs.existsSync(path.join(repo, "out/b.txt"))).toBe(false);

  expect((await listFiles(repo)).body).toEqual({ paths: ["a.txt"], truncated: false });
  expect(await readFile(repo, "out/b.txt")).toEqual(
    refused("Not a file in the working copy: out/b.txt"),
  );
});

test("reports binary and too-large files by size", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "image.png"), Buffer.from("89504e470d0a1a0a0000000d", "hex"));
  write(repo, "late-nul.txt", `${"a".repeat(8000)}\0`);
  write(repo, "big.txt", "x".repeat(g.MAX_FILE_BYTES + 1));
  write(repo, "edge.txt", "x".repeat(g.MAX_FILE_BYTES));

  expect((await readFile(repo, "image.png")).body).toEqual({ kind: "binary", size: 12 });
  // Past the first 8000 bytes, as git looks, a NUL doesn't make a file binary.
  expect((await readFile(repo, "late-nul.txt")).body.content).toHaveLength(8001);
  expect((await readFile(repo, "big.txt")).body).toEqual({
    kind: "tooLarge",
    size: g.MAX_FILE_BYTES + 1,
  });
  expect((await readFile(repo, "edge.txt")).body).toMatchObject({
    kind: "text",
    size: g.MAX_FILE_BYTES,
  });
});

test("never reads more than one byte past the cap", async () => {
  const repo = initRepo();
  write(repo, "big.txt", "x".repeat(1000));
  write(repo, "small.txt", "x".repeat(100));
  const handle = await open(path.join(repo, "small.txt"));
  const proto = Object.getPrototypeOf(handle) as {
    read: (...args: unknown[]) => unknown;
    readFile: (...args: unknown[]) => unknown;
  };
  await handle.close();
  const read = spyOn(proto, "read");
  const readWhole = spyOn(proto, "readFile");
  try {
    // Larger than the cap: the size alone says so, and nothing is read.
    expect(await g.workingFile(repo, "big.txt", 500)).toEqual({ kind: "tooLarge", size: 1000 });
    expect(read).not.toHaveBeenCalled();
    // Under it: reads into a buffer one byte past the cap, never the whole file at once.
    expect(await g.workingFile(repo, "small.txt", 500)).toMatchObject({ kind: "text", size: 100 });
    for (const [buf, offset, length] of read.mock.calls as [Buffer, number, number][]) {
      expect(buf.length).toBe(501);
      expect(offset + length).toBeLessThanOrEqual(501);
    }
    expect(readWhole).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    readWhole.mockRestore();
  }
});

test("decodes invalid UTF-8 with replacement characters", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  expect((await readFile(repo, "latin1.txt")).body).toEqual({
    kind: "text",
    size: 5,
    content: "caf�\n",
  });
});
