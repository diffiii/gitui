import { afterAll, beforeEach, expect, test } from "bun:test";
import { createApp } from "./app.ts";
import { initRepo, removeTempDirs } from "./test-repo.ts";

afterAll(removeTempDirs);

const app = createApp();
let repo: string;

beforeEach(() => {
  repo = initRepo();
});

const req = (url: string, headers: Record<string, string>, init: RequestInit = {}) =>
  app.request(`http://localhost${url}`, { ...init, headers });

test("GET without x-gitui header is rejected", async () => {
  const res = await req("/api/config", { host: "localhost" });
  expect(res.status).toBe(403);
});

test("GET with x-gitui header is allowed", async () => {
  const res = await req("/api/config", { host: "localhost", "x-gitui": "1" });
  expect(res.status).toBe(200);
});

test("GET with header but foreign host is rejected", async () => {
  const res = await req("/api/config", { host: "evil.example", "x-gitui": "1" });
  expect(res.status).toBe(403);
});

test("POST without x-gitui header is rejected", async () => {
  const res = await req(
    "/api/open",
    { host: "localhost", "content-type": "application/json" },
    { method: "POST", body: JSON.stringify({ path: repo }) },
  );
  expect(res.status).toBe(403);
});

test("repo GET without x-gitui header is rejected", async () => {
  const res = await req(`/api/repo/status?repo=${encodeURIComponent(repo)}`, {
    host: "localhost",
  });
  expect(res.status).toBe(403);
});

test("repo GET with x-gitui header is allowed", async () => {
  const res = await req(`/api/repo/status?repo=${encodeURIComponent(repo)}`, {
    host: "localhost",
    "x-gitui": "1",
  });
  expect(res.status).toBe(200);
});
