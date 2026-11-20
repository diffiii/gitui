import { afterAll, expect, test } from "bun:test";
import { HOSTED_ORIGIN } from "@gitui/shared";
import { serverApp } from "./main.ts";
import { removeTempDirs, tmpDir } from "./test-repo.ts";

afterAll(removeTempDirs);

const app = serverApp({
  listener: { kind: "loopback", allowedOrigins: [], token: "t" },
  configDir: tmpDir(),
});

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
