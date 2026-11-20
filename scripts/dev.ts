// Runs each app's `dev` script (API with --watch, Vite+ dev server with /api proxy) together.
// Usage: bun run dev [repo-path]
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const repo = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const env = { ...process.env, ...(repo ? { GITUI_REPO: repo } : {}) };

const procs = ["apps/cli", "apps/web"].map((dir) =>
  Bun.spawn(["bun", "run", "dev"], {
    cwd: path.join(root, dir),
    stdio: ["inherit", "inherit", "inherit"],
    env,
  }),
);

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
