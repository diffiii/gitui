import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, withRepoLock } from "./app.ts";
import * as g from "./git.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeRepo(commit = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitui-")));
  dirs.push(dir);
  await g.git(dir, ["init", "-q", "-b", "main"]);
  await g.git(dir, ["config", "user.name", "Test"]);
  await g.git(dir, ["config", "user.email", "test@example.com"]);
  if (commit) {
    fs.writeFileSync(path.join(dir, "old.txt"), "hello\n");
    await g.git(dir, ["add", "old.txt"]);
    await g.git(dir, ["commit", "-q", "-m", "init"]);
  }
  return dir;
}

const porcelain = async (dir: string) =>
  (await g.git(dir, ["status", "--porcelain", "--untracked-files=all"]))
    .split("\n")
    .filter(Boolean)
    .sort();

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => err,
  );

async function post(dir: string, route: string, body: unknown) {
  return await createApp().request(`/api/repo${route}?repo=${encodeURIComponent(dir)}`, {
    method: "POST",
    headers: { host: "localhost", "x-gitui": "1", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("stage([]) and unstage([]) throw instead of touching the whole tree", async () => {
  const dir = await makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  expect(await rejection(g.stage(dir, []))).toBeInstanceOf(g.GitError);
  expect(await rejection(g.unstage(dir, []))).toBeInstanceOf(g.GitError);
  expect(await porcelain(dir)).toEqual(["?? a.txt"]);
});

test("POST /stage with an empty path list is a 400 and stages nothing", async () => {
  const dir = await makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "old.txt"), "changed\n");
  const res = await post(dir, "/stage", { paths: [] });
  expect(res.status).toBe(400);
  expect(await porcelain(dir)).toEqual([" M old.txt", "?? a.txt"]);
});

test("POST bodies are validated", async () => {
  const dir = await makeRepo();
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
  const dir = await makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  expect((await post(dir, "/stage", { paths: ["a.txt"] })).status).toBe(200);
  expect((await post(dir, "/commit", { message: "add a", amend: false })).status).toBe(200);
  expect((await post(dir, "/branch", { name: "feat", checkout: false })).status).toBe(200);
  expect((await post(dir, "/branch/delete", { name: "feat" })).status).toBe(200);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  const file = { path: "a.txt", x: ".", y: "M" };
  expect((await post(dir, "/discard", { file })).status).toBe(200);
  expect(await porcelain(dir)).toEqual([]);
});

test("unstaging the new side of a staged rename unstages the whole rename", async () => {
  const dir = await makeRepo();
  await g.git(dir, ["mv", "old.txt", "new.txt"]);
  expect(await porcelain(dir)).toEqual(["R  old.txt -> new.txt"]);
  const res = await post(dir, "/unstage", { paths: ["new.txt"] });
  expect(res.status).toBe(200);
  expect(await porcelain(dir)).toEqual([" D old.txt", "?? new.txt"]);
});

test("unstage with no paths works on an unborn repo", async () => {
  const dir = await makeRepo(false);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  await g.stage(dir);
  expect(await porcelain(dir)).toEqual(["A  a.txt"]);
  await g.unstage(dir);
  expect(await porcelain(dir)).toEqual(["?? a.txt"]);
});

test("concurrent stage requests are serialized per repo", async () => {
  const dir = await makeRepo();
  const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
  for (const n of names) fs.writeFileSync(path.join(dir, n), `${n}\n`);
  const responses = await Promise.all(names.map((n) => post(dir, "/stage", { paths: [n] })));
  const bodies = await Promise.all(responses.map((r) => r.json()));
  expect(responses.map((r) => r.status)).toEqual(names.map(() => 200));
  expect(bodies).toEqual(names.map(() => ({ ok: true })));
  expect(await porcelain(dir)).toEqual(names.map((n) => `A  ${n}`).sort());
});

test("withRepoLock runs callers one at a time and releases after a throw", async () => {
  const events: string[] = [];
  const job = (name: string, fail = false) =>
    withRepoLock("k", async () => {
      events.push(`start ${name}`);
      await Bun.sleep(5);
      events.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    });
  const results = await Promise.allSettled([job("a"), job("b", true), job("c")]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  // Different keys don't block each other.
  const order: string[] = [];
  let release!: () => void;
  const held = withRepoLock("x", () => new Promise<void>((r) => (release = r)));
  await withRepoLock("y", async () => order.push("y"));
  release();
  await held;
  expect(order).toEqual(["y"]);
  // And the lock is free again after the failure.
  expect(await withRepoLock("k", async () => "free")).toBe("free");
});
