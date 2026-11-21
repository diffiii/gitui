import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { HOSTED_ORIGIN } from "@gitui/shared";
import { Effect, Exit, Scope } from "effect";
import type { LoopbackListener } from "./access.ts";
import { serverApp, start } from "./main.ts";
import {
  alive,
  client,
  commitFile,
  git,
  initRepo,
  removeTempDirs,
  repoWithOrigin,
  revParse,
  sleeper,
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

/** Waits until `done` holds, checking every 50 ms, for at most `ms`; returns whether it did. */
async function until(done: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (done()) return true;
  return done();
}

describe("on a real socket", () => {
  let port: number;
  let scope: Scope.Closeable;
  beforeAll(async () => {
    scope = Effect.runSync(Scope.make());
    port = await Effect.runPromise(
      Scope.provide(scope)(start({ port: 51890, listener, configDir: tmpDir() })),
    );
  });
  afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  /** A socket that has sent `text`, exactly as written. */
  const connect = (text: string) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    socket.on("error", () => {});
    return socket;
  };

  /** The status line of the response to `text`, sent as is, with Connection: close. */
  const statusOf = (target: string, host: string) =>
    new Promise<string>((resolve) => {
      let out = "";
      connect(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nx-gitui: 1\r\nConnection: close\r\n\r\n`)
        .on("data", (d) => (out += d))
        .on("close", () => resolve(out.split("\r\n", 1)[0]!));
    });

  /** The head of a JSON POST to `route` on `repo`, with Content-Length `length`. */
  const postHead = (repo: string, route: string, length: number) =>
    `POST /api/repo${route}?repo=${encodeURIComponent(repo)} HTTP/1.1\r\nHost: localhost\r\n` +
    `x-gitui: 1\r\ncontent-type: application/json\r\ncontent-length: ${length}\r\n\r\n`;

  test("request targets that a Request would normalize are refused or 404 as sent", async () => {
    // new Request() resolves dot segments and backslashes before the app sees them; a socket
    // sends them as written.
    const cases: [string, string][] = [
      ["/api/config", "200 OK"],
      ["/./api/config", "404 Not Found"],
      ["/api/./config", "404 Not Found"],
      ["/api\\config", "404 Not Found"],
      ["/api%2fconfig", "404 Not Found"],
      ["/api/%2e%2e/api/config", "404 Not Found"],
      ["/api/../api/config", "404 Not Found"],
      ["/api/repo/../config", "404 Not Found"],
      ["api/config", "400 Bad Request"],
      ["*", "400 Bad Request"],
    ];
    for (const [target, status] of cases) {
      expect([target, await statusOf(target, "localhost")]).toEqual([target, `HTTP/1.1 ${status}`]);
    }
  });

  test("an absolute-form target names the host, whatever the Host header says", async () => {
    // Effect takes the host from an absolute-form target, as RFC 9112 says a server must, so
    // the Host header is ignored. Browsers send origin-form (`GET /api/config`) to a server
    // they reach directly, so a rebound name still shows in the checked Host; this pins what
    // a hand-made request gets.
    const at = (host: string) => `http://${host}/api/config`;
    expect(await statusOf(at(`127.0.0.1:${port}`), "evil.example")).toBe("HTTP/1.1 200 OK");
    expect(await statusOf(at("evil.example"), "localhost")).toBe("HTTP/1.1 403 Forbidden");
  });

  test("a slow request body holds up no other write to the repo", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    write(repo, "b.txt", "b\n");
    // 4 of the 100 bytes it announced, and then nothing.
    const slow = connect(postHead(repo, "/stage", 100) + '{"pa');
    try {
      await Bun.sleep(300);
      const started = Date.now();
      const res = await fetch(
        `http://127.0.0.1:${port}/api/repo/branch?repo=${encodeURIComponent(repo)}`,
        {
          method: "POST",
          headers: { "x-gitui": "1", "content-type": "application/json" },
          body: JSON.stringify({ name: "made", checkout: false }),
          signal: AbortSignal.timeout(3000),
        },
      );
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(git(repo, "branch", "--list", "made")).toContain("made");
    } finally {
      slow.destroy();
    }
    expect(git(repo, "status", "--porcelain")).toBe("?? b.txt\n");
  });

  test("a fetch whose client goes away is stopped, git and all", async () => {
    const { repo } = repoWithOrigin();
    // An upload-pack that never answers, so the fetch hangs.
    const uploadPack = sleeper();
    git(repo, "config", "remote.origin.uploadpack", uploadPack.command);
    const client = connect(postHead(repo, "/remote/fetch", 0));
    expect(await until(() => uploadPack.pid() !== null)).toBe(true);
    const pid = uploadPack.pid()!;
    expect(alive(pid)).toBe(true);
    client.destroy();
    expect(await until(() => !alive(pid))).toBe(true);
  });

  test("a commit whose client goes away still lands", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    const head = revParse(repo);
    fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 1\n", {
      mode: 0o755,
    });
    write(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");
    const body = JSON.stringify({ message: "landed" });
    const client = connect(postHead(repo, "/commit", Buffer.byteLength(body)) + body);
    await Bun.sleep(300);
    client.destroy();
    expect(await until(() => revParse(repo) !== head)).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("landed");
  });

  test("a write still queued when its client goes away never runs", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n");
    const dir = tmpDir();
    const marker = path.join(dir, "hook-ran");
    const release = path.join(dir, "release");
    fs.writeFileSync(
      path.join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch '${marker}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\n`,
      { mode: 0o755 },
    );
    write(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");
    const commit = JSON.stringify({ message: "first" });
    const holder = connect(postHead(repo, "/commit", Buffer.byteLength(commit)) + commit);
    try {
      // The hook runs, so the commit holds the repo's lock until the release file exists.
      expect(await until(() => fs.existsSync(marker))).toBe(true);
      const branch = JSON.stringify({ name: "dropped", checkout: false });
      const queued = connect(postHead(repo, "/branch", Buffer.byteLength(branch)) + branch);
      await Bun.sleep(500);
      queued.destroy();
      // Time for the server to see the client go, before the commit lets go of the lock.
      await Bun.sleep(200);
      fs.writeFileSync(release, "");
      // The lock is first come, first served: had the dropped write run, it would run first.
      const res = await fetch(
        `http://127.0.0.1:${port}/api/repo/branch?repo=${encodeURIComponent(repo)}`,
        {
          method: "POST",
          headers: { "x-gitui": "1", "content-type": "application/json" },
          body: JSON.stringify({ name: "after", checkout: false }),
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(res.status).toBe(200);
      expect(git(repo, "branch", "--list", "dropped")).toBe("");
      expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("first");
    } finally {
      fs.writeFileSync(release, "");
      holder.destroy();
    }
  });
});
