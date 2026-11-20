// Runs the API server (with --watch) and the Vite+ dev server together.
// Usage: bun run dev [repo-path]
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const repo = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const env = { ...process.env, ...(repo ? { GITUI_REPO: repo } : {}) };

const procs = [
  Bun.spawn(["bun", "--watch", "server/main.ts"], {
    cwd: path.join(root, "apps/cli"),
    stdio: ["inherit", "inherit", "inherit"],
    env,
  }),
  Bun.spawn(["vp", "dev"], {
    cwd: path.join(root, "apps/web"),
    stdio: ["inherit", "inherit", "inherit"],
    env,
  }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
