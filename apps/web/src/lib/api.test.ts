// Golden requests: every client function sends exactly the method, URL and body it sent before
// the client was built from the contract, since the hosted page must keep talking to every CLI.
// A new client function gets a line here too.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiUrl, type FileStatus } from "@gitui/shared";
import { QueryClient } from "@tanstack/react-query";
import { call, getConfig, openRepo, repoApi } from "./api.ts";
import { initConnection } from "./connection.ts";

interface Sent {
  method: string;
  url: string;
  contentType: string | null;
  body: string | undefined;
}

const sent: Sent[] = [];
const signals: (AbortSignal | null | undefined)[] = [];

// The dev server's connection, which sends requests to its own /api with the page's fetch.
beforeAll(() => {
  stub("location", new URL("http://localhost:5173/"));
  stub("document", { addEventListener: () => {} });
  stub("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stub("addEventListener", () => {});
  stub("fetch", (url: string, init: RequestInit) => {
    sent.push({
      method: init.method!,
      url,
      contentType: new Headers(init.headers).get("content-type"),
      body: init.body as string | undefined,
    });
    signals.push(init.signal);
    return Promise.resolve(Response.json({ ok: true }));
  });
  initConnection(new QueryClient(), { dev: true });
});
afterAll(restoreGlobals);
beforeEach(() => void (sent.length = signals.length = 0));

/** What `send` put on the wire. */
async function request(send: () => Promise<unknown>) {
  await send();
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

const get = (url: string): Sent => ({ method: "GET", url, contentType: null, body: undefined });
const post = (url: string, body?: string): Sent => ({
  method: "POST",
  url,
  contentType: body === undefined ? null : "application/json",
  body,
});

const api = repoApi("/r");
const file: FileStatus = { path: "a b.txt", x: "M", y: ".", untracked: false };

const golden: [string, () => Promise<unknown>, Sent][] = [
  ["getConfig", () => getConfig(), get("/api/config")],
  ["openRepo", () => openRepo("/r"), post("/api/open", '{"path":"/r"}')],
  ["status", () => api.status(), get("/api/repo/status?repo=%2Fr")],
  [
    "diff",
    () => api.diff({ path: "a.txt", staged: true }),
    get("/api/repo/diff?repo=%2Fr&path=a.txt&staged=1&untracked=0"),
  ],
  [
    "diff with an empty origPath",
    () => api.diff({ path: "a.txt", origPath: "", staged: false }),
    get("/api/repo/diff?repo=%2Fr&path=a.txt&origPath=&staged=0&untracked=0"),
  ],
  [
    "diff of a rename, untracked",
    () => api.diff({ path: "b c.txt", origPath: "a&b.txt", staged: false, untracked: true }),
    get("/api/repo/diff?repo=%2Fr&path=b+c.txt&origPath=a%26b.txt&staged=0&untracked=1"),
  ],
  ["stage all", () => api.stage(), post("/api/repo/stage?repo=%2Fr", "{}")],
  [
    "stage",
    () => api.stage(["a.txt", "b.txt"]),
    post("/api/repo/stage?repo=%2Fr", '{"paths":["a.txt","b.txt"]}'),
  ],
  ["unstage all", () => api.unstage(), post("/api/repo/unstage?repo=%2Fr", "{}")],
  [
    "unstage",
    () => api.unstage(["a.txt"]),
    post("/api/repo/unstage?repo=%2Fr", '{"paths":["a.txt"]}'),
  ],
  [
    "discard",
    () => api.discard(file),
    post(
      "/api/repo/discard?repo=%2Fr",
      '{"file":{"path":"a b.txt","x":"M","y":".","untracked":false}}',
    ),
  ],
  [
    "applyLines",
    () =>
      api.applyLines({
        path: "a b.txt",
        action: "unstage",
        base: "ab".repeat(32),
        lines: { deletions: [3], additions: [4, 5] },
      }),
    post(
      "/api/repo/apply-lines?repo=%2Fr",
      `{"path":"a b.txt","action":"unstage","base":"${"ab".repeat(32)}","lines":{"deletions":[3],"additions":[4,5]}}`,
    ),
  ],
  [
    "commit",
    () => api.commit("Fix it", false),
    post("/api/repo/commit?repo=%2Fr", '{"message":"Fix it","amend":false}'),
  ],
  [
    "amend",
    () => api.commit("", true),
    post("/api/repo/commit?repo=%2Fr", '{"message":"","amend":true}'),
  ],
  ["lastMessage", () => api.lastMessage(), get("/api/repo/last-message?repo=%2Fr")],
  [
    "log",
    () => api.log({ limit: 300, all: false }),
    get("/api/repo/log?repo=%2Fr&limit=300&all=0"),
  ],
  [
    "log of a ref",
    () => api.log({ limit: 50, all: true, ref: "origin/main" }),
    get("/api/repo/log?repo=%2Fr&limit=50&all=1&ref=origin%2Fmain"),
  ],
  [
    "log of an empty ref",
    () => api.log({ limit: 300, all: false, ref: "" }),
    get("/api/repo/log?repo=%2Fr&limit=300&all=0&ref="),
  ],
  ["showCommit", () => api.showCommit("abc/1"), get("/api/repo/commit/abc%2F1?repo=%2Fr")],
  ["files", () => api.files(), get("/api/repo/files?repo=%2Fr")],
  ["file", () => api.file("src/a b.ts"), get("/api/repo/file?repo=%2Fr&path=src%2Fa+b.ts")],
  ["branches", () => api.branches(), get("/api/repo/branches?repo=%2Fr")],
  [
    "checkout",
    () => api.checkout("origin/dev", true),
    post("/api/repo/checkout?repo=%2Fr", '{"name":"origin/dev","remote":true}'),
  ],
  [
    "checkout of a local branch",
    () => api.checkout("dev", false),
    post("/api/repo/checkout?repo=%2Fr", '{"name":"dev","remote":false}'),
  ],
  [
    "createBranch",
    () => api.createBranch("dev"),
    post("/api/repo/branch?repo=%2Fr", '{"name":"dev"}'),
  ],
  [
    "createBranch from a commit",
    () => api.createBranch("dev", "abc"),
    post("/api/repo/branch?repo=%2Fr", '{"name":"dev","from":"abc"}'),
  ],
  [
    "createBranch from an empty from",
    () => api.createBranch("dev", ""),
    post("/api/repo/branch?repo=%2Fr", '{"name":"dev","from":""}'),
  ],
  [
    "deleteBranch, not forced",
    () => api.deleteBranch("dev", false),
    post("/api/repo/branch/delete?repo=%2Fr", '{"name":"dev","force":false}'),
  ],
  [
    "deleteBranch",
    () => api.deleteBranch("dev", true),
    post("/api/repo/branch/delete?repo=%2Fr", '{"name":"dev","force":true}'),
  ],
  ["fetch", () => api.remote("fetch"), post("/api/repo/remote/fetch?repo=%2Fr")],
  ["pull", () => api.remote("pull"), post("/api/repo/remote/pull?repo=%2Fr")],
  ["push", () => api.remote("push"), post("/api/repo/remote/push?repo=%2Fr")],
];

for (const [name, send, expected] of golden) {
  test(`${name} sends what it always has`, async () => {
    expect(await request(send)).toEqual(expected);
  });
}

test("a repository's path is escaped in ?repo=", async () => {
  const { url } = await request(() => repoApi("C:\\Users\\me\\my repo").status());
  expect(url).toBe("/api/repo/status?repo=C%3A%5CUsers%5Cme%5Cmy+repo");
});

test("a read's signal reaches fetch", async () => {
  const controller = new AbortController();
  await api.log({ limit: 1, all: false }, { signal: controller.signal });
  await getConfig({ signal: controller.signal });
  expect(signals).toEqual([controller.signal, controller.signal]);
});

test("apiUrl fills path parameters and leaves out undefined query keys", () => {
  expect(apiUrl("showCommit", { repo: "/r", params: { hash: "a b" } })).toBe(
    "/api/repo/commit/a%20b?repo=%2Fr",
  );
  expect(apiUrl("log", { repo: "/r", query: { limit: 1, all: false, ref: undefined } })).toBe(
    "/api/repo/log?repo=%2Fr&limit=1&all=0",
  );
  expect(apiUrl("config", {})).toBe("/api/config");
});

/**
 * What `call` refuses, for `tsc -b` (never called): each line after a `@ts-expect-error` is one
 * the type check fails.
 */
export function refusedByTheTypeCheck() {
  return [
    // A call the contract has.
    call("commit", { repo: "/r", body: { message: "m" } }),
    // @ts-expect-error: status is under /api/repo, so it names its repository.
    call("status", {}),
    // @ts-expect-error: config isn't.
    call("config", { repo: "/r" }),
    // @ts-expect-error: commit's message is a string.
    call("commit", { repo: "/r", body: { message: 1 } }),
    // @ts-expect-error: commit takes a body.
    call("commit", { repo: "/r" }),
    // @ts-expect-error: fetch takes none.
    call("fetch", { repo: "/r", body: {} }),
    // @ts-expect-error: diff's query has `staged` and `untracked`.
    call("diff", { repo: "/r", query: { path: "a" } }),
    // @ts-expect-error: showCommit's path names a `hash`.
    call("showCommit", { repo: "/r" }),
    // @ts-expect-error: and only that.
    call("showCommit", { repo: "/r", params: { sha: "x" } }),
    // @ts-expect-error: status has no path parameters.
    call("status", { repo: "/r", params: { hash: "x" } }),
  ];
}

const saved: [string, PropertyDescriptor | undefined][] = [];

/** Replaces the global `name` until `restoreGlobals`. */
function stub(name: string, value: unknown) {
  saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
function restoreGlobals() {
  for (const [name, d] of saved.reverse()) {
    if (d) Object.defineProperty(globalThis, name, d);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  saved.length = 0;
}
