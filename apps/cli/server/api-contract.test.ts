// The app serves @gitui/shared's API contract: every endpoint of it and no other (the 404
// catch-alls aside), its query schemas read the query strings the contract's `apiUrl` spells,
// and its route helpers refuse a schema or an answer that doesn't match the contract.
import { afterAll, expect, test } from "bun:test";
import { API, apiUrl, type ApiRequest, type RepoApiKey, type ResponseOf } from "@gitui/shared";
import { Effect, Schema } from "effect";
import { API_ROUTES, repoRoute, route } from "./app.ts";
import { commitFile, git, initRepo, removeTempDirs, testApp, write } from "./test-repo.ts";

afterAll(removeTempDirs);

test("the routes served are exactly the contract's endpoints", () => {
  const served = API_ROUTES.filter((r) => r.path !== "/api/*").map((r) => `${r.method} ${r.path}`);
  const contract = Object.values(API).map((e) => `${e.method} ${e.path}`);
  expect(new Set(served)).toEqual(new Set(contract));
  expect(served).toHaveLength(contract.length);
});

/** What the app answers a GET to `key`, at the URL the web client builds for it. */
async function get<K extends RepoApiKey>(
  key: K,
  request: Omit<ApiRequest<K>, "body">,
): Promise<ResponseOf<K>> {
  const res = await testApp().request(apiUrl(key, request), {
    headers: { host: "localhost", "x-gitui": "1" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ResponseOf<K>;
}

test("the log route reads the limit, flags and ref the client sends", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "a\n", "one");
  commitFile(repo, "a.txt", "b\n", "two");
  git(repo, "checkout", "-q", "-b", "side");
  commitFile(repo, "b.txt", "b\n", "on side");
  git(repo, "checkout", "-q", "main");
  const subjects = async (query: { limit: number; all: boolean; ref?: string }) =>
    (await get("log", { repo, query })).commits.map((c) => c.subject);

  expect(await subjects({ limit: 10, all: false })).toEqual(["two", "one"]);
  expect(await subjects({ limit: 10, all: true })).toEqual(["on side", "two", "one"]);
  expect(await subjects({ limit: 1, all: false })).toEqual(["two"]);
  expect(await subjects({ limit: 10, all: false, ref: "side" })).toEqual(["on side", "two", "one"]);
  expect(await subjects({ limit: 10, all: false, ref: "" })).toEqual(["two", "one"]);
});

test("the diff route reads the flags and origPath the client sends", async () => {
  const repo = initRepo();
  commitFile(repo, "a.txt", "one\n");
  write(repo, "a.txt", "two\n");
  git(repo, "add", "a.txt");
  write(repo, "a.txt", "three\n");
  write(repo, "new.txt", "new\n");
  const diff = async (query: {
    path: string;
    origPath?: string;
    staged: boolean;
    untracked: boolean;
  }) => (await get("diff", { repo, query })).diff;

  const staged = await diff({ path: "a.txt", staged: true, untracked: false });
  expect(staged).toContain("+two");
  expect(staged).not.toContain("+three");
  const unstaged = await diff({ path: "a.txt", origPath: "", staged: false, untracked: false });
  expect(unstaged).toContain("+three");
  expect(unstaged).not.toContain("+two");
  expect(await diff({ path: "new.txt", staged: false, untracked: true })).toContain("+new");
});

/**
 * What the route helpers refuse, for `tsc -b` (never called): each line after a
 * `@ts-expect-error` is one the type check fails.
 */
export function refusedByTheTypeCheck() {
  const ok = { ok: true } as const;
  const commitBody = Schema.Struct({ message: Schema.String });
  return [
    // A route that matches the contract.
    repoRoute("lastMessage", {}, () => Effect.succeed({ message: "x" })),
    // @ts-expect-error: lastMessage answers `{ message }`.
    repoRoute("lastMessage", {}, () => Effect.succeed({ msg: "x" })),
    // @ts-expect-error: fetch answers `{ ok, output }`.
    repoRoute("fetch", {}, () => Effect.succeed(ok)),
    // @ts-expect-error: commit's body has an `amend` too.
    repoRoute("commit", { body: commitBody }, () => Effect.succeed({ ...ok, output: "" })),
    // @ts-expect-error: log reads a query.
    repoRoute("log", {}, () => Effect.succeed({ commits: [] })),
    // @ts-expect-error: lastMessage reads no body.
    repoRoute("lastMessage", { body: commitBody }, () => Effect.succeed({ message: "x" })),
    // @ts-expect-error: file's query is `{ path }`, not `{ name }`.
    repoRoute("file", { query: Schema.Struct({ name: Schema.String }) }, () => Effect.die("")),
    // @ts-expect-error: showCommit's path names `hash`.
    repoRoute("showCommit", {}, (_, { params }) => Effect.die(params.sha)),
    // @ts-expect-error: status is under /api/repo, so it goes through the repo gate.
    route("status", {}, () => Effect.die("")),
  ];
}
