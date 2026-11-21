import { afterAll, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadToken } from "./config.ts";
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
