import { afterAll, beforeEach, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { createApp, MAX_BODY_BYTES } from "./app.ts";
import { withRepoLock } from "./lock.ts";
import { client, commitFile, git, initRepo, removeTempDirs } from "./test-repo.ts";

afterAll(removeTempDirs);

const ALLOWED = "https://hosted.example";
const TOKEN = "secret-token";
const app = client(
  createApp({ listener: { kind: "loopback", allowedOrigins: [ALLOWED], token: TOKEN } }),
);
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
  // "null" comes from sandboxed frames and file:// pages; a loopback page on another port is
  // a different origin too.
  for (const origin of ["https://evil.example", "null", "http://127.0.0.1:5000"]) {
    for (const method of ["GET", "OPTIONS"]) {
      const res = await req(
        "/api/config",
        { host: "127.0.0.1:4777", origin, "x-gitui": "1", authorization: `Bearer ${TOKEN}` },
        { method },
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
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

// The router matches some paths that aren't spelled /api/...: it decodes percent escapes and
// stops at `;`. None of these may get past the access checks, nor reach a route another way.
const ODD_PATHS = [
  "//api/config",
  "/API/config",
  "/%61pi/config",
  "/api/%63onfig",
  "/api/config/",
  "/api/config;x",
  "/api/",
  "/api;x",
  "/api/repo/branch;x",
  "//api/repo/branch",
  "/API/repo/branch",
  "/%61pi/repo/branch",
  "/api//repo/branch",
];

/** Ways to call: none of the right headers, all of them, and each one wrong. */
const CALLERS: Record<string, string>[] = [
  {},
  { host: "localhost", "x-gitui": "1" },
  { host: "evil.example", "x-gitui": "1" },
  { host: "localhost" },
  { host: "127.0.0.1:4870", origin: "https://evil.example", "x-gitui": "1" },
  { host: "127.0.0.1:4870", origin: ALLOWED, "x-gitui": "1", authorization: `Bearer ${TOKEN}` },
];

test("odd spellings of API paths are refused or 404, and change nothing", async () => {
  commitFile(repo, "a.txt", "a\n");
  const branches = () => git(repo, "branch", "--format=%(refname:short)");
  const before = branches();
  const answered: unknown[] = [];
  for (const odd of ODD_PATHS) {
    const url = `${odd}?repo=${encodeURIComponent(repo)}`;
    for (const headers of CALLERS) {
      for (const [method, type] of [
        ["GET", undefined],
        ["POST", "application/json"],
        ["POST", "text/plain"],
      ] as const) {
        const res = await req(
          url,
          type ? { ...headers, "content-type": type } : headers,
          type ? { method, body: JSON.stringify({ name: "pwned" }) } : { method },
        );
        if (![401, 403, 404].includes(res.status)) {
          answered.push({ odd, headers, method, type, status: res.status });
        }
      }
    }
  }
  expect(answered).toEqual([]);
  expect(branches()).toBe(before);
});

test("the API itself still answers at its own paths", async () => {
  commitFile(repo, "a.txt", "a\n");
  const res = await req(
    `/api/repo/branch?repo=${encodeURIComponent(repo)}`,
    { host: "localhost", "x-gitui": "1", "content-type": "application/json" },
    { method: "POST", body: JSON.stringify({ name: "made", checkout: false }) },
  );
  expect(res.status).toBe(200);
  expect(git(repo, "branch", "--list", "made")).toContain("made");
});

test("a POST whose body isn't declared JSON is a 415, and changes nothing", async () => {
  commitFile(repo, "a.txt", "a\n");
  for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
    const res = await req(
      `/api/repo/branch?repo=${encodeURIComponent(repo)}`,
      { host: "localhost", "x-gitui": "1", ...(type ? { "content-type": type } : {}) },
      { method: "POST", body: JSON.stringify({ name: "nope" }) },
    );
    expect(res.status).toBe(415);
  }
  expect(git(repo, "branch", "--list", "nope")).toBe("");
});

test("a body over the cap is a 413", async () => {
  const res = await req(
    "/api/open",
    { host: "localhost", "x-gitui": "1", "content-type": "application/json" },
    { method: "POST", body: JSON.stringify({ path: "x".repeat(MAX_BODY_BYTES) }) },
  );
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "Request body too large" });
});

test("HEAD answers like GET, behind the same checks, and takes no lock", async () => {
  const url = `/api/repo/status?repo=${encodeURIComponent(repo)}`;
  // The repo's lock, held until the end: a HEAD that waited for it would never answer.
  const held = Effect.runFork(withRepoLock(repo, Effect.never));
  try {
    const res = await req(url, { host: "localhost", "x-gitui": "1" }, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect((await req(url, { host: "localhost" }, { method: "HEAD" })).status).toBe(403);
    const stage = await req(
      `/api/repo/stage?repo=${encodeURIComponent(repo)}`,
      { host: "localhost", "x-gitui": "1" },
      { method: "HEAD" },
    );
    expect(stage.status).toBe(404);
  } finally {
    await Effect.runPromise(Fiber.interrupt(held));
  }
});

test("a preflight for a POST route under /api/repo gets the CORS headers", async () => {
  const res = await req(
    `/api/repo/stage?repo=${encodeURIComponent(repo)}`,
    {
      host: "127.0.0.1:4777",
      origin: ALLOWED,
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-gitui, content-type, authorization",
    },
    { method: "OPTIONS" },
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST");
});

const local = { host: "localhost", "x-gitui": "1" };

test("query parameters are checked like bodies", async () => {
  commitFile(repo, "a.txt", "a\n");
  const at = (route: string, query: string) =>
    req(`/api/repo${route}?repo=${encodeURIComponent(repo)}&${query}`, local);
  for (const [route, query, error] of [
    ["/diff", "path=a.txt&origPath=%00", "Invalid origPath"],
    ["/diff", "path=%00", "Invalid path"],
    ["/diff", "", "Invalid path"],
    ["/diff", "path=../a.txt&untracked=1", "Invalid path"],
    ["/log", "limit=-1", "Invalid limit"],
    ["/log", "limit=0", "Invalid limit"],
    ["/log", "limit=1.5", "Invalid limit"],
    ["/log", "limit=abc", "Invalid limit"],
    ["/log", "ref=-x", "Invalid ref"],
    ["/file", "", "Invalid path"],
  ]) {
    const res = await at(route!, query!);
    expect([route, query, res.status, await res.json()]).toEqual([route, query, 400, { error }]);
  }
  for (const query of ["limit=99999", "limit=1&limit=-1", "ref=&origPath=", "all=1"]) {
    const res = await at("/log", query);
    expect([query, res.status]).toEqual([query, 200]);
  }
  const diff = await at("/diff", "path=a.txt&origPath=");
  expect(diff.status).toBe(200);
});

test("an unexpected failure is a 500 that says nothing of it", async () => {
  // Without git on the PATH, running it is a defect, not a GitError.
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const res = await req(`/api/repo/status?repo=${encodeURIComponent(repo)}`, local);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  } finally {
    process.env.PATH = saved;
  }
});
