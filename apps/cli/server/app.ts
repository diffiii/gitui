import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { type AccessOptions, installAccess } from "./access.ts";
import { pushRecent, readRecent } from "./config.ts";
import * as g from "./git.ts";
import { withRepoLock } from "./lock.ts";

export interface AppOptions extends AccessOptions {
  initialRepo?: string;
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

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

/** Parse a JSON object body; malformed JSON or a non-object is a client error, not a 500. */
async function jsonBody(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  return record(await req.json().catch(() => invalid("JSON body")), "JSON body");
}

/** A string; `fallback`, when given, stands in for an absent field. */
function str(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") invalid(field);
  return value;
}

/** An optional boolean; an absent field is `fallback`. */
function flag(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") invalid(field);
  return value;
}

/** A single repo-relative path; may not be empty or contain NUL. */
function filePath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || !value || value.includes("\0")) invalid(field);
  return value;
}

/** A path to read from the working copy: relative, and never stepping up with `..`. */
function workingPath(value: unknown): string {
  const p = filePath(value);
  if (path.isAbsolute(p) || p.split(/[/\\]/).includes("..")) invalid("path");
  return p;
}

/** `undefined` means "all files"; otherwise a non-empty list of paths. */
function pathList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) invalid("paths");
  return value.map((p) => filePath(p, "paths"));
}

function fileStatus(value: unknown): g.FileStatus {
  const f = record(value, "file");
  return {
    path: filePath(f.path, "file.path"),
    origPath: f.origPath === undefined ? undefined : filePath(f.origPath, "file.origPath"),
    x: str(f.x, "file.x", "."),
    y: str(f.y, "file.y", "."),
    untracked: flag(f.untracked, "file.untracked"),
    conflicted: flag(f.conflicted, "file.conflicted"),
  };
}

/** Long-running network operations that don't write the index skip the repo lock. */
const UNLOCKED_PATHS = /\/remote\/(fetch|push)$/;

type Env = { Variables: { repo: string } };

export function createApp(opts: AppOptions) {
  const app = new Hono<Env>();
  const api = new Hono<Env>();

  installAccess(app, opts);

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
    const { diff, truncated } = await g.fileDiff(c.var.repo, {
      path: q.path,
      origPath: q.origPath || undefined,
      staged: q.staged === "1",
      untracked: q.untracked === "1",
    });
    return c.json({ diff, truncated });
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
    const amend = flag(body.amend, "amend");
    if (!message.trim() && !amend) throw new g.GitError("Commit message is empty", null, "");
    const out = await g.commit(c.var.repo, message, amend);
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

  repo.get("/files", async (c) => c.json(await g.workingFiles(c.var.repo)));

  repo.get("/file", async (c) =>
    c.json(await g.workingFile(c.var.repo, workingPath(c.req.query("path")))),
  );

  repo.get("/branches", async (c) => c.json({ branches: await g.branches(c.var.repo) }));

  repo.post("/checkout", async (c) => {
    const body = await jsonBody(c.req);
    const remote = flag(body.remote, "remote");
    await g.checkout(c.var.repo, ref(body.name, "branch"), remote);
    return c.json({ ok: true });
  });

  repo.post("/branch", async (c) => {
    const body = await jsonBody(c.req);
    const name = ref(body.name, "branch");
    const from = body.from === undefined || body.from === "" ? undefined : ref(body.from, "from");
    await g.createBranch(c.var.repo, name, from, flag(body.checkout, "checkout", true));
    return c.json({ ok: true });
  });

  repo.post("/branch/delete", async (c) => {
    const body = await jsonBody(c.req);
    const force = flag(body.force, "force");
    await g.deleteBranch(c.var.repo, ref(body.name, "branch"), force);
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
  // Unknown API routes get a JSON 404 rather than falling through to the UI's index.html.
  api.all("*", (c) => c.json({ error: "Not found" }, 404));
  app.route("/api", api);
  return app;
}
