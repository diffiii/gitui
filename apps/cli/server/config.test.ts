import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { loadToken, pushRecent, readRecent } from "./config.ts";
import { removeTempDirs, tmpDir, run } from "./test-repo.ts";

afterAll(removeTempDirs);

test("creates a private token once and reuses it", async () => {
  const dir = path.join(tmpDir(), "gitui");
  const token = await run(loadToken(dir));
  expect(token).toMatch(/^[\w-]{43}$/);
  expect(statSync(path.join(dir, "token")).mode & 0o777).toBe(0o600);
  expect(await run(loadToken(dir))).toBe(token);
});

test("replaces a token file that doesn't hold a valid token", async () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "token"), "");
  const token = await run(loadToken(dir));
  expect(token).toMatch(/^[\w-]{43}$/);
  expect(await run(loadToken(dir))).toBe(token);
});

test("tolerates a trailing newline in a hand-edited token file", async () => {
  const dir = tmpDir();
  const token = "a".repeat(43);
  writeFileSync(path.join(dir, "token"), `${token}\n`);
  expect(await run(loadToken(dir))).toBe(token);
});

test("concurrent updates keep every repo", async () => {
  const dir = tmpDir();
  await run(
    Effect.all(
      Array.from({ length: 20 }, (_, i) => pushRecent(`/r${i}`, dir)),
      { concurrency: "unbounded" },
    ),
  );
  const list = await run(readRecent(dir));
  expect(list.length).toBe(20);
  expect(new Set(list).size).toBe(20);
  expect(JSON.parse(readFileSync(path.join(dir, "recent.json"), "utf8"))).toEqual(list);
});

test("keeps the newest 20, without duplicates", async () => {
  const dir = tmpDir();
  await run(pushRecent("/a", dir));
  for (let i = 0; i <= 20; i++) await run(pushRecent(`/r${i}`, dir));
  await run(pushRecent("/r5", dir));
  const list = await run(readRecent(dir));
  expect(list[0]).toBe("/r5");
  expect(list.length).toBe(20);
  expect(list).not.toContain("/a");
});

test("leaves no temporary files behind", async () => {
  const dir = tmpDir();
  for (const repo of ["/a", "/b", "/c"]) await run(pushRecent(repo, dir));
  expect(readdirSync(dir)).toEqual(["recent.json"]);
});
