import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import * as g from "./git.ts";

export interface AppOptions {
  initialRepo?: string;
}

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "gitui",
);
const RECENT_FILE = path.join(CONFIG_DIR, "recent.json");

async function readRecent(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(RECENT_FILE, "utf8"));
  } catch {
    return [];
  }
}

export async function pushRecent(repo: string) {
  const list = [repo, ...(await readRecent()).filter((r) => r !== repo)].slice(0, 20);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(RECENT_FILE, JSON.stringify(list, null, 2));
}

/** Refuse anything git could parse as an option. */
function ref(value: unknown, field = "ref"): string {
  if (typeof value !== "string" || !value || value.startsWith("-") || /[\0\n]/.test(value)) {
    throw new g.GitError(`Invalid ${field}`, null, "");
  }
  return value;
}

function invalid(field: string): never {
  throw new g.GitError(`Invalid ${field}`, null, "");
}

/** Parse a JSON object body; malformed JSON or a non-object is a client error, not a 500. */
async function jsonBody(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => invalid("JSON body"));
  if (typeof body !== "object" || body === null || Array.isArray(body)) invalid("JSON body");
  return body as Record<string, unknown>;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field);
  return value;
}

function optStr(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : str(value, field);
}

function optBool(value: unknown, field: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") invalid(field);
  return value;
}

/** A single repo-relative path; may not be empty or contain NUL. */
function filePath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || !value || value.includes("\0")) invalid(field);
  return value;
}

/** `undefined` means "all files"; otherwise a non-empty list of paths. */
function pathList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) invalid("paths");
  return value.map((p) => filePath(p, "paths"));
}

function fileStatus(value: unknown): g.FileStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("file");
  const f = value as Record<string, unknown>;
  return {
    path: filePath(f.path, "file.path"),
    origPath: f.origPath === undefined ? undefined : filePath(f.origPath, "file.origPath"),
    x: optStr(f.x, "file.x") ?? ".",
    y: optStr(f.y, "file.y") ?? ".",
    untracked: optBool(f.untracked, "file.untracked"),
    conflicted: optBool(f.conflicted, "file.conflicted"),
  };
}

const repoLocks = new Map<string, Promise<void>>();

/** Run `fn` after every earlier call for the same `key` has settled (a per-repo FIFO mutex). */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => (release = r)));
  repoLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  }
}

/** Long-running network operations that don't write the index skip the repo lock. */
const UNLOCKED_PATHS = /\/remote\/(fetch|push)$/;

type Env = { Variables: { repo: string } };

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<Env>();
  const api = new Hono<Env>();

  // Only accept requests addressed to localhost (defends against DNS rebinding) and require a
  // custom header on mutations, which cross-origin pages can't send without a CORS preflight.
  app.use("/api/*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("Forbidden host", 403);
    if (c.req.method !== "GET" && c.req.header("x-gitui") !== "1") return c.text("Forbidden", 403);
    await next();
  });

  app.onError((err, c) => {
    const message = err instanceof g.GitError ? err.message : String(err);
    return c.json({ error: message }, err instanceof g.GitError ? 400 : 500);
  });

  api.get("/config", async (c) =>
    c.json({
      initialRepo: opts.initialRepo ?? null,
      recent: await readRecent(),
      home: os.homedir(),
    }),
  );

  api.post("/open", async (c) => {
    const { path: p } = await c.req.json<{ path: string }>();
    const root = await g.resolveRepo(p);
    await pushRecent(root);
    return c.json({ root, name: path.basename(root) });
  });

  // Everything below operates on ?repo=<absolute path>
  const repo = new Hono<Env>();
  repo.use("*", async (c, next) => {
    const r = c.req.query("repo");
    if (!r) return c.json({ error: "Missing repo" }, 400);
    c.set("repo", await g.resolveRepo(r));
    await next();
  });

  // Serialize mutations per repo so concurrent git commands don't collide on .git/index.lock.
  repo.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || UNLOCKED_PATHS.test(c.req.path)) {
      return next();
    }
    return withRepoLock(c.var.repo, next);
  });

  repo.get("/status", async (c) => c.json(await g.status(c.var.repo)));

  repo.get("/diff", async (c) => {
    const q = c.req.query();
    const diff = await g.fileDiff(c.var.repo, {
      path: q.path,
      origPath: q.origPath || undefined,
      staged: q.staged === "1",
      untracked: q.untracked === "1",
    });
    return c.json({ diff });
  });

  repo.post("/stage", async (c) => {
    const body = await jsonBody(c.req);
    await g.stage(c.var.repo, pathList(body.paths));
    return c.json({ ok: true });
  });

  repo.post("/unstage", async (c) => {
    const body = await jsonBody(c.req);
    await g.unstage(c.var.repo, pathList(body.paths));
    return c.json({ ok: true });
  });

  repo.post("/discard", async (c) => {
    const body = await jsonBody(c.req);
    await g.discard(c.var.repo, fileStatus(body.file));
    return c.json({ ok: true });
  });

  repo.post("/commit", async (c) => {
    const body = await jsonBody(c.req);
    const message = str(body.message, "message");
    const amend = optBool(body.amend, "amend");
    if (!message.trim() && !amend) throw new g.GitError("Commit message is empty", null, "");
    const out = await g.commit(c.var.repo, message, !!amend);
    return c.json({ ok: true, output: out });
  });

  repo.get("/last-message", async (c) =>
    c.json({ message: await g.lastCommitMessage(c.var.repo) }),
  );

  repo.get("/log", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 300) || 300, 5000);
    const r = c.req.query("ref");
    const commits = await g.log(c.var.repo, {
      limit,
      all: c.req.query("all") === "1",
      ref: r ? ref(r) : undefined,
    });
    return c.json({ commits });
  });

  repo.get("/commit/:hash", async (c) =>
    c.json(await g.showCommit(c.var.repo, ref(c.req.param("hash"), "hash"))),
  );

  repo.get("/branches", async (c) => c.json({ branches: await g.branches(c.var.repo) }));

  repo.post("/checkout", async (c) => {
    const body = await jsonBody(c.req);
    const remote = optBool(body.remote, "remote");
    await g.checkout(c.var.repo, ref(body.name, "branch"), !!remote);
    return c.json({ ok: true });
  });

  repo.post("/branch", async (c) => {
    const body = await jsonBody(c.req);
    const name = ref(body.name, "branch");
    const from = body.from === undefined || body.from === "" ? undefined : ref(body.from, "from");
    const checkout = optBool(body.checkout, "checkout");
    await g.createBranch(c.var.repo, name, from, checkout ?? true);
    return c.json({ ok: true });
  });

  repo.post("/branch/delete", async (c) => {
    const body = await jsonBody(c.req);
    const force = optBool(body.force, "force");
    await g.deleteBranch(c.var.repo, ref(body.name, "branch"), !!force);
    return c.json({ ok: true });
  });

  repo.post("/remote/:action", async (c) => {
    const action = c.req.param("action");
    if (action !== "fetch" && action !== "pull" && action !== "push")
      return c.json({ error: "Bad action" }, 400);
    const output = await g.remoteAction(c.var.repo, action);
    return c.json({ ok: true, output });
  });

  api.route("/repo", repo);
  app.route("/api", api);
  return app;
}
