import { afterAll, beforeEach, expect, test } from "bun:test";
import { createApp } from "./app.ts";
import { initRepo, removeTempDirs } from "./test-repo.ts";

afterAll(removeTempDirs);

const ALLOWED = "https://hosted.example";
const TOKEN = "secret-token";
const app = createApp({ allowedOrigins: [ALLOWED], token: TOKEN });
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

const fromAllowed = { host: "127.0.0.1:4777", origin: ALLOWED, "x-gitui": "1" };

test("preflight from an allowed origin gets CORS and private-network headers", async () => {
  const res = await req(
    "/api/config",
    {
      host: "127.0.0.1:4777",
      origin: ALLOWED,
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-gitui, authorization",
      "access-control-request-private-network": "true",
    },
    { method: "OPTIONS" },
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST");
  expect(res.headers.get("access-control-allow-headers")).toBe(
    "x-gitui, content-type, authorization",
  );
  expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  expect(res.headers.get("access-control-max-age")).toBeTruthy();
  expect(res.headers.get("vary")).toBe("Origin");
});

test("allowed origin without a token gets a 401 it can read", async () => {
  const res = await req("/api/config", fromAllowed);
  expect(res.status).toBe(401);
  expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  expect(((await res.json()) as { error: string }).error).toBeTruthy();
});

test("allowed origin with a wrong token gets a 401", async () => {
  const res = await req("/api/config", { ...fromAllowed, authorization: "Bearer nope" });
  expect(res.status).toBe(401);
  expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
});

test("allowed origin with the token is allowed", async () => {
  const res = await req("/api/config", { ...fromAllowed, authorization: `Bearer ${TOKEN}` });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  expect(res.headers.get("vary")).toBe("Origin");
});

test("allowed origin still needs the x-gitui header", async () => {
  const res = await req("/api/config", {
    host: "127.0.0.1:4777",
    origin: ALLOWED,
    authorization: `Bearer ${TOKEN}`,
  });
  expect(res.status).toBe(403);
});

test("error responses to an allowed origin carry CORS headers", async () => {
  const res = await req("/api/repo/status?repo=%2Fnonexistent%2Fgitui", {
    ...fromAllowed,
    authorization: `Bearer ${TOKEN}`,
  });
  expect(res.status).toBe(400);
  expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  expect(res.headers.get("vary")).toBe("Origin");
});

test("other origins are rejected without CORS headers", async () => {
  for (const method of ["GET", "OPTIONS"]) {
    const res = await req(
      "/api/config",
      { host: "127.0.0.1:4777", origin: "https://evil.example", "x-gitui": "1" },
      { method },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
});

test("same-origin request needs no token", async () => {
  const res = await req("/api/config", {
    host: "localhost:4777",
    origin: "http://localhost:4777",
    "x-gitui": "1",
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});
