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
    const { paths } = await c.req.json<{ paths?: string[] }>();
    await g.stage(c.var.repo, paths);
    return c.json({ ok: true });
  });

  repo.post("/unstage", async (c) => {
    const { paths } = await c.req.json<{ paths?: string[] }>();
    await g.unstage(c.var.repo, paths);
    return c.json({ ok: true });
  });

  repo.post("/discard", async (c) => {
    const { file } = await c.req.json<{ file: g.FileStatus }>();
    await g.discard(c.var.repo, file);
    return c.json({ ok: true });
  });

  repo.post("/commit", async (c) => {
    const { message, amend } = await c.req.json<{ message: string; amend?: boolean }>();
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
    const { name, remote } = await c.req.json<{ name: string; remote?: boolean }>();
    await g.checkout(c.var.repo, ref(name, "branch"), !!remote);
    return c.json({ ok: true });
  });

  repo.post("/branch", async (c) => {
    const { name, from, checkout } = await c.req.json<{
      name: string;
      from?: string;
      checkout?: boolean;
    }>();
    await g.createBranch(
      c.var.repo,
      ref(name, "branch"),
      from ? ref(from) : undefined,
      checkout ?? true,
    );
    return c.json({ ok: true });
  });

  repo.post("/branch/delete", async (c) => {
    const { name, force } = await c.req.json<{ name: string; force?: boolean }>();
    await g.deleteBranch(c.var.repo, ref(name, "branch"), !!force);
    return c.json({ ok: true });
  });

  repo.post("/remote/:action", async (c) => {
    const action = c.req.param("action");
    if (action !== "fetch" && action !== "pull" && action !== "push")
      return c.json({ error: "Bad action" }, 400);
    // Pushes and fetches can outlast Bun's idleTimeout; disable it for this request only.
    // c.env is the Bun Server under Bun.serve, and undefined under app.request() in tests.
    (c.env as { timeout?(req: Request, seconds: number): void } | undefined)?.timeout?.(
      c.req.raw,
      0,
    );
    const output = await g.remoteAction(c.var.repo, action);
    return c.json({ ok: true, output });
  });

  api.route("/repo", repo);
  app.route("/api", api);
  return app;
}
