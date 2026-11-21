import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Data, Effect, Fiber } from "effect";
import * as g from "./git.ts";
import { diffBase } from "./lines.ts";
import { withRepoLock } from "./lock.ts";
import {
  commitFile,
  git,
  initRepo,
  removeTempDirs,
  revParse,
  run,
  testApp,
  write,
} from "./test-repo.ts";

afterAll(removeTempDirs);

function makeRepo(commit = true) {
  const dir = initRepo();
  if (commit) commitFile(dir, "old.txt", "hello\n", "init");
  return dir;
}

const porcelain = async (dir: string) =>
  (await run(g.git(dir, ["status", "--porcelain", "--untracked-files=all"])))
    .split("\n")
    .filter(Boolean)
    .sort();

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => err,
  );

async function post(dir: string, route: string, body: unknown) {
  return await testApp().request(`/api/repo${route}?repo=${encodeURIComponent(dir)}`, {
    method: "POST",
    headers: { host: "localhost", "x-gitui": "1", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("stage([]) and unstage([]) throw instead of touching the whole tree", async () => {
  const dir = makeRepo();
  write(dir, "a.txt", "a\n");
  expect(await rejection(run(g.stage(dir, [])))).toBeInstanceOf(g.GitError);
  expect(await rejection(run(g.unstage(dir, [])))).toBeInstanceOf(g.GitError);
  expect(await porcelain(dir)).toEqual(["?? a.txt"]);
});

test("POST /stage with an empty path list is a 400 and stages nothing", async () => {
  const dir = makeRepo();
  write(dir, "a.txt", "a\n");
  write(dir, "old.txt", "changed\n");
  const res = await post(dir, "/stage", { paths: [] });
  expect(res.status).toBe(400);
  expect(await porcelain(dir)).toEqual([" M old.txt", "?? a.txt"]);
});

test("POST bodies are validated", async () => {
  const dir = makeRepo();
  const cases: [string, unknown][] = [
    ["/commit", {}],
    ["/commit", { message: 42 }],
    ["/commit", { message: "x", amend: "yes" }],
    ["/stage", { paths: "a.txt" }],
    ["/stage", { paths: [""] }],
    ["/stage", { paths: ["a\0b"] }],
    ["/stage", { paths: [1] }],
    ["/unstage", { paths: [] }],
    ["/stage", "not json"],
    ["/stage", [1, 2]],
    ["/discard", {}],
    ["/discard", { file: { path: 1 } }],
    ["/discard", { file: { path: "old.txt", untracked: "no" } }],
    ["/checkout", {}],
    ["/checkout", { name: "--orphan" }],
    ["/checkout", { name: "main", remote: 1 }],
    ["/branch", { name: "x", checkout: "true" }],
    ["/branch", { name: "x", from: "-x" }],
    ["/branch/delete", { name: "x", force: "1" }],
  ];
  for (const [route, body] of cases) {
    const res = await post(dir, route, body);
    expect({ route, body, status: res.status }).toEqual({ route, body, status: 400 });
  }
  expect(await porcelain(dir)).toEqual([]);
});

test("valid bodies still work", async () => {
  const dir = makeRepo();
  write(dir, "a.txt", "a\n");
  expect((await post(dir, "/stage", { paths: ["a.txt"] })).status).toBe(200);
  expect((await post(dir, "/commit", { message: "add a", amend: false })).status).toBe(200);
  expect((await post(dir, "/branch", { name: "feat", checkout: false })).status).toBe(200);
  expect((await post(dir, "/branch/delete", { name: "feat" })).status).toBe(200);
  write(dir, "a.txt", "changed\n");
  const file = { path: "a.txt", x: ".", y: "M" };
  expect((await post(dir, "/discard", { file })).status).toBe(200);
  write(dir, "b.txt", "b\n");
  const untracked = { path: "b.txt", x: ".", y: "?", untracked: true };
  expect((await post(dir, "/discard", { file: untracked })).status).toBe(200);
  expect(await porcelain(dir)).toEqual([]);
});

test("unstaging the new side of a staged rename unstages the whole rename", async () => {
  const dir = makeRepo();
  git(dir, "mv", "old.txt", "new.txt");
  expect(await porcelain(dir)).toEqual(["R  old.txt -> new.txt"]);
  const res = await post(dir, "/unstage", { paths: ["new.txt"] });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual([" D old.txt", "?? new.txt"]);
});

test("unstaging an unrelated path leaves a staged rename alone", async () => {
  const dir = makeRepo();
  git(dir, "mv", "old.txt", "new.txt");
  write(dir, "a.txt", "a\n");
  await run(g.stage(dir, ["a.txt"]));
  expect((await post(dir, "/unstage", { paths: ["a.txt"] })).status).toBe(200);
  expect(await porcelain(dir)).toEqual(["?? a.txt", "R  old.txt -> new.txt"]);
});

test("unstage with no paths works on an unborn repo", async () => {
  const dir = makeRepo(false);
  write(dir, "a.txt", "a\n");
  await run(g.stage(dir));
  expect(await porcelain(dir)).toEqual(["A  a.txt"]);
  await run(g.unstage(dir));
  expect(await porcelain(dir)).toEqual(["?? a.txt"]);
});

test("concurrent stage requests are serialized per repo", async () => {
  const dir = makeRepo();
  const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
  for (const n of names) write(dir, n, `${n}\n`);
  const responses = await Promise.all(names.map((n) => post(dir, "/stage", { paths: [n] })));
  const bodies = await Promise.all(responses.map((r) => r.json()));
  expect(responses.map((r) => r.status)).toEqual(names.map(() => 200));
  expect(bodies).toEqual(names.map(() => ({ ok: true })));
  expect(await porcelain(dir)).toEqual(names.map((n) => `A  ${n}`).sort());
});

test("withRepoLock runs callers one at a time and releases after a failure", async () => {
  class JobError extends Data.TaggedError("JobError")<{ name: string }> {}
  const events: string[] = [];
  const job = (name: string, fail = false) =>
    withRepoLock(
      "k",
      Effect.gen(function* () {
        events.push(`start ${name}`);
        yield* Effect.sleep(5);
        events.push(`end ${name}`);
        if (fail) return yield* Effect.fail(new JobError({ name }));
        return name;
      }),
    );
  const results = await Promise.allSettled(
    [job("a"), job("b", true), job("c")].map((e) => Effect.runPromise(e)),
  );
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  // Different keys don't block each other.
  const order: string[] = [];
  let release!: () => void;
  const held = Effect.runPromise(
    withRepoLock(
      "x",
      Effect.promise(() => new Promise<void>((r) => (release = r))),
    ),
  );
  await Effect.runPromise(
    withRepoLock(
      "y",
      Effect.sync(() => order.push("y")),
    ),
  );
  release();
  await held;
  expect(order).toEqual(["y"]);
  // And the lock is free again after the failure.
  expect(await Effect.runPromise(withRepoLock("k", Effect.succeed("free")))).toBe("free");
});

test("withRepoLock lets go of a lock whose holder is interrupted", async () => {
  const fiber = Effect.runFork(withRepoLock("i", Effect.never));
  await Bun.sleep(1);
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(await Effect.runPromise(withRepoLock("i", Effect.succeed("free")))).toBe("free");
});

test("a commit finishes even if the client goes away while git runs", async () => {
  const dir = makeRepo();
  const head = revParse(dir);
  const hook = path.join(dir, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
  write(dir, "a.txt", "a\n");
  git(dir, "add", "a.txt");
  const aborted = new AbortController();
  const res = testApp().fetch(
    new Request(`http://localhost/api/repo/commit?repo=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { host: "localhost", "x-gitui": "1", "content-type": "application/json" },
      body: JSON.stringify({ message: "slow" }),
      signal: aborted.signal,
    }),
  );
  await Bun.sleep(200);
  aborted.abort();
  await res.catch(() => {});
  // The hook is still running; once it's done, so is the commit.
  expect(revParse(dir)).toBe(head);
  for (let i = 0; i < 50 && revParse(dir) === head; i++) await Bun.sleep(100);
  expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("slow");
});

// ---------------------------------------------------------------- literal paths, safe discard

const discard = (dir: string, file: Record<string, unknown>) =>
  post(dir, "/discard", { file: { x: ".", y: ".", ...file } });

function globRepo() {
  const dir = initRepo();
  commitFile(dir, "src/[id].tsx", "1\n");
  commitFile(dir, "src/i.tsx", "1\n");
  commitFile(dir, "src/d.tsx", "1\n");
  return dir;
}

test("discard treats the path literally", async () => {
  const dir = globRepo();
  for (const f of ["[id]", "i", "d"]) write(dir, `src/${f}.tsx`, "2\n");
  expect((await discard(dir, { path: "src/[id].tsx", y: "M" })).status).toBe(200);
  expect(await porcelain(dir)).toEqual([" M src/d.tsx", " M src/i.tsx"]);
});

test("clean treats the path literally", async () => {
  const dir = initRepo();
  commitFile(dir, "keep.txt", "k\n");
  for (const f of ["[ab]", "a", "b"]) write(dir, `src/${f}.txt`, "x\n");
  const res = await discard(dir, { path: "src/[ab].txt", y: "?", untracked: true });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual(["?? src/a.txt", "?? src/b.txt"]);
});

// Windows file names can't hold a colon.
test.skipIf(process.platform === "win32")("a name starting with a colon is literal", async () => {
  const dir = initRepo();
  commitFile(dir, "other", "1\n");
  write(dir, ":!keep", "1\n");
  git(dir, "add", "--", ":(literal):!keep");
  git(dir, "commit", "-q", "-m", "colon");
  write(dir, ":!keep", "2\n");
  write(dir, "other", "2\n");
  expect((await discard(dir, { path: ":!keep", y: "M" })).status).toBe(200);
  expect(await porcelain(dir)).toEqual([" M other"]);
});

test("stage and unstage treat paths literally", async () => {
  const dir = globRepo();
  write(dir, "src/[id].tsx", "2\n");
  write(dir, "src/i.tsx", "2\n");
  expect((await post(dir, "/stage", { paths: ["src/[id].tsx"] })).status).toBe(200);
  expect(await porcelain(dir)).toEqual([" M src/i.tsx", "M  src/[id].tsx"]);
  expect((await post(dir, "/unstage", { paths: ["src/[id].tsx"] })).status).toBe(200);
  expect(await porcelain(dir)).toEqual([" M src/[id].tsx", " M src/i.tsx"]);
});

test("a file diff treats the path literally", async () => {
  const dir = globRepo();
  write(dir, "src/[id].tsx", "2\n");
  write(dir, "src/i.tsx", "2\n");
  const { diff } = await run(g.fileDiff(dir, { path: "src/[id].tsx", staged: false }));
  expect(diff).toContain("src/[id].tsx");
  expect(diff).not.toContain("src/i.tsx");
});

test("unstage works on an unborn branch for a file edited after staging", async () => {
  const setup = async () => {
    const dir = initRepo();
    write(dir, "a.txt", "1\n");
    write(dir, "b.txt", "1\n");
    await run(g.stage(dir));
    write(dir, "a.txt", "2\n");
    return dir;
  };
  const one = await setup();
  await run(g.unstage(one, ["a.txt"]));
  expect(await porcelain(one)).toEqual(["?? a.txt", "A  b.txt"]);
  expect(fs.readFileSync(path.join(one, "a.txt"), "utf8")).toBe("2\n");

  const all = await setup();
  await run(g.unstage(all));
  expect(await porcelain(all)).toEqual(["?? a.txt", "?? b.txt"]);
});

test.each([
  { path: ".", untracked: true },
  { path: "x", untracked: true },
  { path: "x/", untracked: true },
  { path: "missing.txt" },
])("discard refuses what isn't a single listed file: %o", async (file) => {
  const dir = initRepo();
  commitFile(dir, "c.txt", "c\n");
  write(dir, "x/1.txt", "1\n");
  write(dir, "x/2.txt", "2\n");
  write(dir, "y.txt", "y\n");
  const before = await porcelain(dir);
  expect((await discard(dir, file)).status).toBe(400);
  expect(await porcelain(dir)).toEqual(before);
});

test("discard ignores the client's untracked flag", async () => {
  const dir = initRepo();
  commitFile(dir, "t.txt", "1\n");
  write(dir, "t.txt", "2\n");
  expect((await discard(dir, { path: "t.txt", y: "M", untracked: true })).status).toBe(200);
  expect(fs.readFileSync(path.join(dir, "t.txt"), "utf8")).toBe("1\n");

  write(dir, "u.txt", "u\n");
  expect((await discard(dir, { path: "u.txt", untracked: false })).status).toBe(200);
  expect(fs.existsSync(path.join(dir, "u.txt"))).toBe(false);
});

test("discard of a fully staged file is a 400", async () => {
  const dir = initRepo();
  commitFile(dir, "s.txt", "1\n");
  write(dir, "s.txt", "2\n");
  git(dir, "add", "s.txt");
  expect((await discard(dir, { path: "s.txt", y: "M" })).status).toBe(400);
  expect(await porcelain(dir)).toEqual(["M  s.txt"]);
});

test("discard of a conflicted file is a 400", async () => {
  const dir = initRepo();
  commitFile(dir, "f.txt", "base\n");
  git(dir, "switch", "-q", "-c", "other");
  commitFile(dir, "f.txt", "theirs\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "f.txt", "ours\n");
  expect(() => git(dir, "merge", "-q", "other")).toThrow();
  expect((await discard(dir, { path: "f.txt", x: "U", y: "U", conflicted: true })).status).toBe(
    400,
  );
  expect(await porcelain(dir)).toEqual(["UU f.txt"]);
});

test("discard of a staged rename with work tree edits keeps the rename", async () => {
  const dir = initRepo();
  commitFile(dir, "old.txt", "content that is long enough to be detected\nmore\n");
  git(dir, "mv", "old.txt", "new.txt");
  write(dir, "new.txt", "content that is long enough to be detected\nmore\nedit\n");
  expect(await porcelain(dir)).toEqual(["RM old.txt -> new.txt"]);
  expect((await discard(dir, { path: "new.txt", x: "R", y: "M" })).status).toBe(200);
  expect(await porcelain(dir)).toEqual(["R  old.txt -> new.txt"]);
});

test("discard of an intent-to-add rename restores both sides", async () => {
  const dir = initRepo();
  commitFile(dir, "old.txt", "content that is long enough to be detected\nmore\n");
  fs.renameSync(path.join(dir, "old.txt"), path.join(dir, "new.txt"));
  git(dir, "add", "-N", "new.txt");
  const st = await run(g.status(dir));
  const entry = st.files.find((f) => f.path === "new.txt");
  expect(entry?.y).toBe("R");
  expect((await discard(dir, { path: "new.txt", y: "R" })).status).toBe(200);
  // The deleted original is back; git leaves the intent-to-add file itself.
  expect(await porcelain(dir)).toEqual([" A new.txt"]);
  expect(fs.existsSync(path.join(dir, "old.txt"))).toBe(true);
});

test("discard refuses a submodule and a nested repository", async () => {
  const dir = initRepo();
  const sub = path.join(dir, "sub");
  fs.mkdirSync(sub);
  initRepo(sub);
  commitFile(sub, "f", "1\n");
  git(dir, "add", "sub");
  git(dir, "commit", "-q", "-m", "sub");
  write(sub, "f", "2\n");
  expect((await discard(dir, { path: "sub", y: "M" })).status).toBe(400);

  const nested = path.join(dir, "nested");
  fs.mkdirSync(nested);
  initRepo(nested);
  write(nested, "n.txt", "n\n");
  expect((await discard(dir, { path: "nested/", untracked: true })).status).toBe(400);
  expect(fs.existsSync(path.join(nested, "n.txt"))).toBe(true);
});

// ---------------------------------------------------------------- lines

/** The file's diff as the Changes view gets it. */
async function getDiff(dir: string, file: string, staged: boolean, origPath?: string) {
  const query = new URLSearchParams({ repo: dir, path: file });
  if (origPath) query.set("origPath", origPath);
  query.set("staged", staged ? "1" : "0");
  query.set("untracked", "0");
  const res = await testApp().request(`/api/repo/diff?${query.toString()}`, {
    headers: { host: "localhost", "x-gitui": "1" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { diff: string; truncated: boolean; base?: string };
}

interface Pick {
  path: string;
  origPath?: string;
  action: "stage" | "unstage" | "discard";
  deletions?: number[];
  additions?: number[];
  /** Defaults to the base of the diff the action's side shows now. */
  base?: string;
}

/** POST /apply-lines for lines of the diff the page would show now. */
async function applyLines(dir: string, pick: Pick) {
  const staged = pick.action === "unstage";
  const base = pick.base ?? (await getDiff(dir, pick.path, staged, pick.origPath)).base;
  return post(dir, "/apply-lines", {
    path: pick.path,
    action: pick.action,
    base,
    lines: { deletions: pick.deletions ?? [], additions: pick.additions ?? [] },
  });
}

const indexed = (dir: string, file: string) => git(dir, "show", `:${file}`);
const worktree = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const errorOf = async (res: Response) => ({
  status: res.status,
  error: ((await res.json()) as { error: string }).error,
});

const ALPHABET = "abcdefghijkl".split("");
const text = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
// a..l -> A b..k L m: a hunk at the top (-a +A) and one at the bottom (-l +L +m).
const EDITED = text(["A", ...ALPHABET.slice(1, 11), "L", "m"]);

/** A repo with `f` committed as a..l and edited to EDITED in the work tree. */
function twoHunks() {
  const dir = initRepo();
  commitFile(dir, "f", text(ALPHABET));
  write(dir, "f", EDITED);
  return dir;
}

test("/diff answers a base for a tracked file's diff and none for an untracked one", async () => {
  const dir = twoHunks();
  const unstaged = await getDiff(dir, "f", false);
  expect(unstaged.base).toBe(diffBase(unstaged.diff));
  expect(unstaged.base).toMatch(/^[0-9a-f]{64}$/);
  git(dir, "add", "f");
  const staged = await getDiff(dir, "f", true);
  expect(staged.base).toBe(unstaged.base);

  write(dir, "u.txt", "u\n");
  const res = await testApp().request(
    `/api/repo/diff?repo=${encodeURIComponent(dir)}&path=u.txt&staged=0&untracked=1`,
    { headers: { host: "localhost", "x-gitui": "1" } },
  );
  const untracked = (await res.json()) as { diff: string; base?: string };
  expect(untracked.diff).toContain("+u");
  expect("base" in untracked).toBe(false);
});

test("stages one of two hunks", async () => {
  const dir = twoHunks();
  expect((await getDiff(dir, "f", false)).diff.match(/^@@ /gm)).toHaveLength(2);
  const res = await applyLines(dir, {
    path: "f",
    action: "stage",
    deletions: [12],
    additions: [12, 13],
  });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual(["MM f"]);
  const cached = git(dir, "diff", "--cached");
  expect(cached).toContain("+m");
  expect(cached).not.toContain("+A");
  expect(indexed(dir, "f")).toBe(text([...ALPHABET.slice(0, 11), "L", "m"]));
  expect(worktree(dir, "f")).toBe(EDITED);
});

test("stages one added line next to a deleted one", async () => {
  const dir = twoHunks();
  expect((await applyLines(dir, { path: "f", action: "stage", additions: [13] })).status).toBe(200);
  expect(indexed(dir, "f")).toBe(text([...ALPHABET, "m"]));
});

test("unstages one line of a fully staged change", async () => {
  const dir = twoHunks();
  git(dir, "add", "f");
  expect((await applyLines(dir, { path: "f", action: "unstage", additions: [13] })).status).toBe(
    200,
  );
  expect(indexed(dir, "f")).toBe(text(["A", ...ALPHABET.slice(1, 11), "L"]));
  expect(await porcelain(dir)).toEqual(["MM f"]);
  expect(worktree(dir, "f")).toBe(EDITED);
});

test("unstages a line below a hunk that adds lines, with or without that hunk", async () => {
  const dir = initRepo();
  commitFile(dir, "f", text(ALPHABET));
  const edited = text(["A", "A2", ...ALPHABET.slice(1, 11), "L", "m"]);
  write(dir, "f", edited);
  git(dir, "add", "f");
  // The bottom hunk alone: its place in the index is below the top hunk's extra line.
  expect((await applyLines(dir, { path: "f", action: "unstage", additions: [14] })).status).toBe(
    200,
  );
  expect(indexed(dir, "f")).toBe(text(["A", "A2", ...ALPHABET.slice(1, 11), "L"]));
  git(dir, "add", "f");
  // Both: the bottom hunk moves up by the top one's line.
  const both = await applyLines(dir, { path: "f", action: "unstage", additions: [2, 14] });
  expect(both.status).toBe(200);
  expect(indexed(dir, "f")).toBe(text(["A", ...ALPHABET.slice(1, 11), "L"]));
});

test("discards one hunk from the work tree and leaves the index alone", async () => {
  const dir = twoHunks();
  const res = await applyLines(dir, {
    path: "f",
    action: "discard",
    deletions: [1],
    additions: [1],
  });
  expect(res.status).toBe(200);
  expect(worktree(dir, "f")).toBe(text([...ALPHABET.slice(0, 11), "L", "m"]));
  expect(indexed(dir, "f")).toBe(text(ALPHABET));
  expect(await porcelain(dir)).toEqual([" M f"]);
});

test("a stale base is refused and changes nothing", async () => {
  const dir = twoHunks();
  const { base } = await getDiff(dir, "f", false);
  write(dir, "f", `${EDITED}n\n`);
  const before = { status: await porcelain(dir), index: indexed(dir, "f") };
  const res = await applyLines(dir, { path: "f", action: "stage", additions: [13], base });
  expect(await errorOf(res)).toEqual({
    status: 400,
    error: "This diff changed since it was shown; look at it again",
  });
  expect({ status: await porcelain(dir), index: indexed(dir, "f") }).toEqual(before);
  expect(worktree(dir, "f")).toBe(`${EDITED}n\n`);
});

test("unstaging a hunk of a staged rename keeps the rename", async () => {
  const dir = initRepo();
  commitFile(dir, "old.txt", text(ALPHABET));
  git(dir, "mv", "old.txt", "new.txt");
  write(dir, "new.txt", EDITED);
  git(dir, "add", "new.txt");
  expect(await porcelain(dir)).toEqual(["R  old.txt -> new.txt"]);
  const res = await applyLines(dir, {
    path: "new.txt",
    origPath: "old.txt",
    action: "unstage",
    deletions: [1],
    additions: [1],
  });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual(["RM old.txt -> new.txt"]);
  expect(indexed(dir, "new.txt")).toBe(text([...ALPHABET.slice(0, 11), "L", "m"]));
  expect(git(dir, "diff", "--", "new.txt")).toContain("-a\n+A\n");
});

test("partially unstages a staged new file and partially stages a deletion", async () => {
  const dir = initRepo();
  commitFile(dir, "d", "x\ny\n");
  write(dir, "n", "1\n2\n3\n");
  git(dir, "add", "n");
  expect((await applyLines(dir, { path: "n", action: "unstage", additions: [2] })).status).toBe(
    200,
  );
  expect(indexed(dir, "n")).toBe("1\n3\n");
  expect(await porcelain(dir)).toContain("AM n");

  fs.rmSync(path.join(dir, "d"));
  expect((await applyLines(dir, { path: "d", action: "stage", deletions: [1] })).status).toBe(200);
  expect(indexed(dir, "d")).toBe("y\n");
});

test("a last line without a newline is staged byte for byte, and not split off", async () => {
  const dir = initRepo();
  commitFile(dir, "f", "a\nb\nc");
  write(dir, "f", "a\nB\nc\nd");
  const alone = await applyLines(dir, { path: "f", action: "stage", additions: [4] });
  expect(await errorOf(alone)).toEqual({
    status: 400,
    error: "Include the change to the file's last line",
  });
  expect(await porcelain(dir)).toEqual([" M f"]);
  const res = await applyLines(dir, {
    path: "f",
    action: "stage",
    deletions: [2],
    additions: [2],
  });
  expect(res.status).toBe(200);
  expect(indexed(dir, "f")).toBe("a\nB\nc");
});

test("CRLF lines are staged byte for byte", async () => {
  const dir = initRepo();
  commitFile(dir, "w", "a\r\nb\r\n");
  write(dir, "w", "A\r\nb\r\nc\r\n");
  expect((await applyLines(dir, { path: "w", action: "stage", additions: [3] })).status).toBe(200);
  expect(indexed(dir, "w")).toBe("a\r\nb\r\nc\r\n");
});

test("a repo's apply.whitespace can't rewrite or refuse the staged lines", async () => {
  for (const mode of ["fix", "error"]) {
    const dir = initRepo();
    git(dir, "config", "apply.whitespace", mode);
    commitFile(dir, "s", "a\n");
    write(dir, "s", "a\nb  \nc\t\n");
    const res = await applyLines(dir, { path: "s", action: "stage", additions: [2] });
    expect({ mode, status: res.status }).toEqual({ mode, status: 200 });
    expect(indexed(dir, "s")).toBe("a\nb  \n");
  }
});

test("line actions are refused for what they can't do", async () => {
  const dir = twoHunks();
  const base = "0".repeat(64);
  write(dir, "u.txt", "u\n");
  commitFile(dir, "staged-only", "1\n");
  commitFile(dir, "gone", "1\n2\n");
  commitFile(dir, "removed", "1\n2\n");
  write(dir, "staged-only", "2\n");
  git(dir, "add", "staged-only");
  fs.rmSync(path.join(dir, "gone"));
  git(dir, "rm", "-q", "removed");
  const cases: [Pick, string][] = [
    [{ path: "u.txt", action: "stage", additions: [1], base }, "Stage the whole file first: u.txt"],
    [{ path: "nope", action: "stage", additions: [1], base }, "No changes in nope"],
    [{ path: "f", action: "unstage", additions: [13], base }, "Nothing staged in f"],
    [
      { path: "staged-only", action: "stage", additions: [1], base },
      "No unstaged changes in staged-only",
    ],
    [
      { path: "staged-only", action: "discard", additions: [1], base },
      "No unstaged changes in staged-only",
    ],
    [{ path: "gone", action: "discard", deletions: [1], base }, "Discard the whole file: gone"],
    [
      { path: "removed", action: "unstage", deletions: [1], base },
      "Unstage the whole file: removed",
    ],
    [{ path: "f", action: "stage" }, "Nothing selected"],
    [
      { path: "f", action: "stage", additions: [5] },
      "The selection names lines this diff doesn't change",
    ],
    [
      { path: "f", action: "stage", deletions: [13] },
      "The selection names lines this diff doesn't change",
    ],
  ];
  for (const [pick, error] of cases) {
    const res = await applyLines(dir, pick);
    expect({ pick, ...(await errorOf(res)) }).toEqual({ pick, status: 400, error });
  }
  expect(await porcelain(dir)).toEqual([
    " D gone",
    " M f",
    "?? u.txt",
    "D  removed",
    "M  staged-only",
  ]);
  expect(indexed(dir, "f")).toBe(text(ALPHABET));
});

test("line actions refuse a conflicted file, a submodule and a nested repository", async () => {
  const dir = initRepo();
  commitFile(dir, "c.txt", "base\n");
  git(dir, "switch", "-q", "-c", "other");
  commitFile(dir, "c.txt", "theirs\n");
  git(dir, "switch", "-q", "main");
  commitFile(dir, "c.txt", "ours\n");
  expect(() => git(dir, "merge", "-q", "other")).toThrow();

  const sub = path.join(dir, "sub");
  fs.mkdirSync(sub);
  initRepo(sub);
  commitFile(sub, "f", "1\n");
  git(dir, "add", "sub");
  write(sub, "f", "2\n");

  const nested = path.join(dir, "nested");
  fs.mkdirSync(nested);
  initRepo(nested);
  write(nested, "n.txt", "n\n");

  const base = "0".repeat(64);
  const cases: [Pick, string][] = [
    [
      { path: "c.txt", action: "stage", additions: [1], base },
      "Resolve the conflict in c.txt first",
    ],
    [
      { path: "sub", action: "stage", additions: [1], base },
      "Can't pick lines in a repository: sub",
    ],
    [
      { path: "sub", action: "unstage", additions: [1], base },
      "Can't pick lines in a repository: sub",
    ],
    [
      { path: "nested/", action: "stage", additions: [1], base },
      "Can't pick lines in a repository: nested/",
    ],
  ];
  for (const [pick, error] of cases) {
    const res = await applyLines(dir, pick);
    expect({ pick, ...(await errorOf(res)) }).toEqual({ pick, status: 400, error });
  }
  expect(fs.readFileSync(path.join(sub, "f"), "utf8")).toBe("2\n");
});

test("/apply-lines bodies are validated", async () => {
  const dir = twoHunks();
  const { base } = await getDiff(dir, "f", false);
  const good = {
    path: "f",
    action: "stage",
    base,
    lines: { deletions: [], additions: [13] },
  };
  const cases: [unknown, string][] = [
    [{ ...good, path: "" }, "Invalid path"],
    [{ ...good, action: "apply" }, "Invalid action"],
    [{ ...good, base: "abc" }, "Invalid base"],
    [{ ...good, base: base!.toUpperCase() }, "Invalid base"],
    [{ ...good, lines: [] }, "Invalid lines"],
    [{ ...good, lines: { deletions: [] } }, "Invalid lines.additions"],
    [{ ...good, lines: { deletions: [0], additions: [] } }, "Invalid lines.deletions"],
    [{ ...good, lines: { deletions: [1.5], additions: [] } }, "Invalid lines.deletions"],
    [{ ...good, lines: { deletions: [], additions: ["1"] } }, "Invalid lines.additions"],
    [
      { ...good, lines: { deletions: [], additions: Array.from({ length: 100_001 }, () => 1) } },
      "Too many lines.additions",
    ],
  ];
  for (const [body, error] of cases) {
    const res = await post(dir, "/apply-lines", body);
    const shown = JSON.stringify(body).slice(0, 80);
    expect({ shown, ...(await errorOf(res)) }).toEqual({ shown, status: 400, error });
  }
  expect(await porcelain(dir)).toEqual([" M f"]);
  expect((await post(dir, "/apply-lines", good)).status).toBe(200);
});

test("every line of a deleted file stages the deletion", async () => {
  const dir = initRepo();
  commitFile(dir, "d", "x\ny\n");
  fs.rmSync(path.join(dir, "d"));
  const res = await applyLines(dir, { path: "d", action: "stage", deletions: [1, 2] });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual(["D  d"]);
});

test("every line of a staged new file unstages it", async () => {
  const dir = initRepo();
  commitFile(dir, "old.txt", "hello\n");
  write(dir, "n", "1\n2\n3\n");
  git(dir, "add", "n");
  const res = await applyLines(dir, { path: "n", action: "unstage", additions: [1, 2, 3] });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual(["?? n"]);
});

test("every line of a file with a mode change stages the mode too", async () => {
  if (process.platform === "win32") return;
  const dir = initRepo();
  commitFile(dir, "s.sh", "a\n");
  write(dir, "s.sh", "b\n");
  fs.chmodSync(path.join(dir, "s.sh"), 0o755);
  const res = await applyLines(dir, {
    path: "s.sh",
    action: "stage",
    deletions: [1],
    additions: [1],
  });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual(["M  s.sh"]);
  expect(git(dir, "diff", "--cached", "--summary")).toContain("mode change 100644 => 100755");
});

test("lines are staged whatever diff.context and diff.suppressBlankEmpty say", async () => {
  const dir = initRepo();
  git(dir, "config", "diff.context", "0");
  git(dir, "config", "diff.suppressBlankEmpty", "true");
  commitFile(dir, "e", text(["a", "", "b", "c", "", "d"]));
  write(dir, "e", text(["a", "", "B", "C", "", "d"]));
  const { diff } = await getDiff(dir, "e", false);
  expect(diff).toContain("\n \n");
  const res = await applyLines(dir, { path: "e", action: "stage", deletions: [3], additions: [3] });
  expect(res.status).toBe(200);
  expect(indexed(dir, "e")).toBe(text(["a", "", "B", "c", "", "d"]));
});

test("a whole hunk whose last lines have no newline applies, one hunk of two", async () => {
  const dir = initRepo();
  commitFile(dir, "f", `${text(ALPHABET)}x\ny`);
  write(dir, "f", `${text(["A", ...ALPHABET.slice(1)])}x\nY\nz`);
  // The second hunk: -y \ +Y +z \, as -y \ +Y +z \ paired.
  const res = await applyLines(dir, {
    path: "f",
    action: "stage",
    deletions: [14],
    additions: [14, 15],
  });
  expect(res.status).toBe(200);
  expect(indexed(dir, "f")).toBe(`${text(ALPHABET)}x\nY\nz`);
});
