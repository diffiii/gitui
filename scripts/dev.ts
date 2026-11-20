// Runs the API server (with --watch) and the Vite+ dev server together.
// Usage: bun run dev [repo-path]
import path from "node:path";

const repo = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const env = { ...process.env, ...(repo ? { GITUI_REPO: repo } : {}) };

const procs = [
  Bun.spawn(["bun", "--watch", "server/main.ts"], {
    stdio: ["inherit", "inherit", "inherit"],
    env,
  }),
  Bun.spawn(["vp", "dev"], { stdio: ["inherit", "inherit", "inherit"], env }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
