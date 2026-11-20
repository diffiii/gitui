import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.ts";

const app = createApp();
let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitui-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
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
