// Which repositories each listener's clients may use (repo-scope.ts), through the app.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type AppConfig, REPO_NOT_OPENED } from "@gitui/shared";
import { type Listener, NEARBY_HOST } from "./access.ts";
import { API_ROUTES, createApp } from "./app.ts";
import { pushRecent, readRecent } from "./config.ts";
import { client, commitFile, initRepo, removeTempDirs, run, tmpDir, write } from "./test-repo.ts";
import { VERSION } from "./version.ts";

afterAll(removeTempDirs);

/** Routes outside /api/repo, which take no `?repo=`: /open goes through the gate on its own. */
const UNGATED = ["GET /api/config", "POST /api/open"];

/** Values for route parameters, so each route's path matches it. */
const PARAMS: Record<string, string> = { hash: "HEAD" };

/**
 * Every API endpoint the app has, from its route table: "METHOD /path", with each parameter
 * filled in. The 404 catch-alls (`/*`) answer no path of their own and are left out.
 */
const endpoints = () =>
  API_ROUTES.filter((r) => !r.path.endsWith("/*")).map((r) => ({
    name: `${r.method} ${r.path}`,
    method: r.method,
    path: r.path.replace(/:(\w+)/g, (_, name: string) => PARAMS[name] ?? "x"),
  }));

/** A listener of each kind, and the headers its clients send. */
const clients: { listener: Listener; host: string; headers: Record<string, string> }[] = [
  {
    listener: { kind: "loopback", allowedOrigins: ["https://hosted.example"], token: "t" },
    host: "127.0.0.1:4870",
    headers: { origin: "https://hosted.example", authorization: "Bearer t" },
  },
  { listener: { kind: "nearby" }, host: NEARBY_HOST, headers: {} },
];

let configDir: string;
/** Started with `gitui <initial>`. */
let initial: string;
/** Opened on the computer earlier: in the recent list. */
let recent: string;
/** Never opened. */
let other: string;

beforeEach(async () => {
  configDir = tmpDir();
  [initial, recent, other] = [initRepo(), initRepo(), initRepo()];
  for (const repo of [initial, recent, other]) commitFile(repo, "a.txt", "a\n");
  await run(pushRecent(recent, configDir));
  await run(pushRecent(initial, configDir));
});

for (const { listener, host, headers } of clients) {
  const scoped = listener.kind !== "loopback";
  const app = () => client(createApp({ listener, initialRepo: initial, configDir }));
  const send = (url: string, init: { method?: string; body?: unknown } = {}) =>
    app().request(`http://${host}${url}`, {
      method: init.method ?? "GET",
      headers: { host, "x-gitui": "1", "content-type": "application/json", ...headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const status = (repo: string) => send(`/api/repo/status?repo=${encodeURIComponent(repo)}`);
  const open = (p: string) => send("/api/open", { method: "POST", body: { path: p } });
  const refused = async (res: Response) => {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "This repository wasn't opened on the computer running gitui",
      code: REPO_NOT_OPENED,
    });
  };

  describe(`${listener.kind}`, () => {
    test("the initial and recent repositories work", async () => {
      for (const repo of [initial, recent]) expect((await status(repo)).status).toBe(200);
    });

    test("config lists the recent repositories", async () => {
      const config = (await (await send("/api/config")).json()) as AppConfig;
      expect(config.recent).toEqual([initial, recent]);
      expect(config.initialRepo).toBe(initial);
      expect(config.version).toBe(VERSION);
    });

    test("a folder inside an opened repository, or a symlink to one, works", async () => {
      write(initial, "src/x.txt", "x\n");
      const link = path.join(tmpDir(), "link");
      fs.symlinkSync(recent, link);
      expect((await status(path.join(initial, "src"))).status).toBe(200);
      expect((await status(link)).status).toBe(200);
      const res = await open(link);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ root: recent, name: path.basename(recent) });
    });

    if (scoped) {
      test("every route that takes a repository goes through the gate", async () => {
        const all = endpoints();
        expect(all.length).toBeGreaterThan(UNGATED.length);
        for (const { name, method, path: route } of all) {
          if (!route.startsWith("/api/repo/")) {
            // A new route outside /api/repo must be gated, or listed here with the reason.
            expect(UNGATED).toContain(name);
            continue;
          }
          const at = (repo: string) =>
            send(`${route}?repo=${encodeURIComponent(repo)}`, {
              method,
              body: method === "GET" ? undefined : {},
            });
          await refused(await at(other));
          // The path is the route's own: an opened repository gets past the gate to it.
          const res = await at(initial);
          expect([name, res.status]).not.toEqual([name, 404]);
          expect([name, res.status]).not.toEqual([name, 403]);
        }
      });

      test("the route list has every route, and paths no route has are a plain 404", async () => {
        const names = API_ROUTES.map((r) => `${r.method} ${r.path}`);
        expect(names).toContain("GET /api/repo/status");
        // Under /api/repo, the /api/* catch-all answers before any repository is looked at, so
        // it says nothing about the one named.
        expect(names).not.toContain("GET /api/repo/*");
        for (const repo of [other, initial, tmpDir()]) {
          const res = await send(`/api/repo/nope?repo=${encodeURIComponent(repo)}`);
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: "Not found" });
        }
      });

      test("another repository is refused, for reads and writes", async () => {
        await refused(await status(other));
        write(other, "b.txt", "b\n");
        const stage = await send(`/api/repo/stage?repo=${encodeURIComponent(other)}`, {
          method: "POST",
          body: { paths: ["b.txt"] },
        });
        await refused(stage);
        await refused(await send(`/api/repo/files?repo=${encodeURIComponent(other)}`));
        await refused(await send(`/api/repo/file?repo=${encodeURIComponent(other)}&path=a.txt`));
      });

      test("paths that aren't repositories are refused alike, without saying more", async () => {
        const plain = tmpDir();
        for (const p of [plain, path.join(plain, "missing"), "/", "~"])
          await refused(await status(p));
      });

      test("a repository nested in an opened one is refused", async () => {
        const nested = path.join(initial, "nested");
        fs.mkdirSync(nested);
        initRepo(nested);
        await refused(await status(nested));
        await refused(await open(nested));
      });

      test("/open takes opened repositories only, and leaves the recent list alone", async () => {
        const before = await run(readRecent(configDir));
        const res = await open(recent);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ root: recent, name: path.basename(recent) });
        await refused(await open(other));
        await refused(await open(tmpDir()));
        expect(await run(readRecent(configDir))).toEqual(before);
      });

      test("a repository opened on the computer meanwhile works at once", async () => {
        await refused(await status(other));
        await run(pushRecent(other, configDir));
        expect((await status(other)).status).toBe(200);
      });
    } else {
      test("any repository works, and /open adds it to the recent list", async () => {
        expect((await status(other)).status).toBe(200);
        expect((await open(other)).status).toBe(200);
        expect(await run(readRecent(configDir))).toEqual([other, initial, recent]);
      });

      test("a path that isn't a repository is a plain error", async () => {
        const res = await status(tmpDir());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: expect.stringMatching(/^Not a git repository/) });
      });
    }
  });
}
