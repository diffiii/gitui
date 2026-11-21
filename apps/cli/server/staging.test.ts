import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Data, Effect, Fiber } from "effect";
import * as g from "./git.ts";
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

test("a name starting with a colon is literal", async () => {
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
