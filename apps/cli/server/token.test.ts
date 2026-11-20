import { afterAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import path from "node:path";
import { removeTempDirs, tmpDir } from "./test-repo.ts";
import { loadToken } from "./token.ts";

afterAll(removeTempDirs);

test("creates a private token once and reuses it", async () => {
  const dir = path.join(tmpDir(), "gitui");
  const token = await loadToken(dir);
  expect(token).toMatch(/^[\w-]{43}$/);
  expect(statSync(path.join(dir, "token")).mode & 0o777).toBe(0o600);
  expect(await loadToken(dir)).toBe(token);
});
