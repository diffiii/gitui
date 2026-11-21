import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { HOSTED_ORIGIN } from "@gitui/shared";
import { Effect, Exit, Scope } from "effect";
import type { LoopbackListener } from "./access.ts";
import { serverApp, start } from "./main.ts";
import {
  client,
  commitFile,
  git,
  initRepo,
  removeTempDirs,
  revParse,
  tmpDir,
  write,
} from "./test-repo.ts";

afterAll(removeTempDirs);

const listener: LoopbackListener = { kind: "loopback", allowedOrigins: [], token: "t" };

const app = client(serverApp({ listener, configDir: tmpDir() }));

const get = (url: string, headers: Record<string, string> = {}) =>
  app.request(url, { headers: { host: "localhost", ...headers } });

test("/ points to the hosted app", async () => {
  const res = await get("/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(HOSTED_ORIGIN);
});

test("an unknown API route is a JSON 404, and other paths serve nothing", async () => {
  const res = await get("/api/nope", { "x-gitui": "1" });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Not found" });
  expect((await get("/index.html")).status).toBe(404);
});

test("stopping the server stops a slow commit within a few seconds", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n");
  const head = revParse(repo);
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 30\n", {
    mode: 0o755,
  });
  write(repo, "b.txt", "b\n");
  git(repo, "add", "b.txt");

  const scope = Effect.runSync(Scope.make());
  const port = await Effect.runPromise(
    Scope.provide(scope)(start({ port: 51870, listener, configDir: tmpDir() })),
  );
  const res = fetch(`http://127.0.0.1:${port}/api/repo/commit?repo=${encodeURIComponent(repo)}`, {
    method: "POST",
    headers: { "x-gitui": "1", "content-type": "application/json" },
    body: JSON.stringify({ message: "never" }),
  }).catch(() => null);
  await Bun.sleep(300);
  const stopping = Date.now();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(Date.now() - stopping).toBeLessThan(3500);
  await res;
  expect(revParse(repo)).toBe(head);
});
