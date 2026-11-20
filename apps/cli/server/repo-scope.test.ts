// Which repositories each listener's clients may use (repo-scope.ts), through the app.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { REPO_NOT_OPENED } from "@gitui/shared";
import { type Listener, NEARBY_HOST } from "./access.ts";
import { createApp } from "./app.ts";
import { pushRecent, readRecent } from "./config.ts";
import { commitFile, initRepo, removeTempDirs, tmpDir, write } from "./test-repo.ts";

afterAll(removeTempDirs);

/**
 * Routes outside /api/repo, which take no `?repo=`: /open goes through the gate on its own, and
 * /pair is the LAN listener's pairing link.
 */
const UNGATED = ["GET /api/config", "POST /api/open", "GET /pair"];

/** Values for route parameters, so each route's path matches it. */
const PARAMS: Record<string, string> = { hash: "HEAD", action: "fetch" };

/**
 * Every API endpoint the app has, from its router: "METHOD /path". Wildcard registrations for
 * every method are left out: those are `use` middleware (the gate among them) and the 404
 * fallback. An `all()` route on a path is an endpoint, and is sent a POST.
 */
const endpoints = (app: ReturnType<typeof createApp>) =>
  app.routes
    .filter((r) => !(r.method === "ALL" && r.path.endsWith("*")))
    .map((r) => {
      const method = r.method === "ALL" ? "POST" : r.method;
      return {
        name: `${r.method} ${r.path}`,
        method,
        path: r.path.replace(/:(\w+)/g, (_, name: string) => PARAMS[name] ?? "x"),
      };
    });

const LAN = {
  kind: "lan",
  address: "192.168.1.5",
  secret: "s",
  cookie: "gitui-session-t",
} as const;

/** A listener of each kind, and the headers its clients send. */
const clients: { listener: Listener; host: string; headers: Record<string, string> }[] = [
  {
    listener: { kind: "loopback", allowedOrigins: ["https://hosted.example"], token: "t" },
    host: "127.0.0.1:4870",
    headers: { origin: "https://hosted.example", authorization: "Bearer t" },
  },
  { listener: LAN, host: "192.168.1.5:4870", headers: { cookie: "gitui-session-t=s" } },
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
  await pushRecent(recent, configDir);
  await pushRecent(initial, configDir);
});

for (const { listener, host, headers } of clients) {
  const scoped = listener.kind !== "loopback";
  const app = () => createApp({ listener, initialRepo: initial, configDir });
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
      const config = (await (await send("/api/config")).json()) as Record<string, unknown>;
      expect(config.recent).toEqual([initial, recent]);
      expect(config.initialRepo).toBe(initial);
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
        const all = endpoints(app());
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

      test("the route list leaves out middleware only, so all() routes are checked too", () => {
        const routes = app();
        routes.all("/api/repo/extra", (c) => c.text("x"));
        const names = endpoints(routes).map((e) => e.name);
        expect(names).toContain("ALL /api/repo/extra");
        expect(names.filter((name) => name.endsWith("*"))).toEqual([]);
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
        const before = await readRecent(configDir);
        const res = await open(recent);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ root: recent, name: path.basename(recent) });
        await refused(await open(other));
        await refused(await open(tmpDir()));
        expect(await readRecent(configDir)).toEqual(before);
      });

      test("a repository opened on the computer meanwhile works at once", async () => {
        await refused(await status(other));
        await pushRecent(other, configDir);
        expect((await status(other)).status).toBe(200);
      });
    } else {
      test("any repository works, and /open adds it to the recent list", async () => {
        expect((await status(other)).status).toBe(200);
        expect((await open(other)).status).toBe(200);
        expect(await readRecent(configDir)).toEqual([other, initial, recent]);
      });

      test("a path that isn't a repository is a plain error", async () => {
        const res = await status(tmpDir());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: expect.stringMatching(/^Not a git repository/) });
      });
    }
  });
}
