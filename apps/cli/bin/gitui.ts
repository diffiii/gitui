#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { pushRecent } from "../server/app.ts";
import { resolveRepo } from "../server/git.ts";
import { start } from "../server/main.ts";

const HELP = `gitui — git in your browser

Usage:
  gitui            start the app with a repository picker
  gitui <path>     open the repository containing <path> (e.g. \`gitui .\`)

Options:
  -p, --port <n>   port to listen on (default 4777)
  --no-open        don't open the browser
  -h, --help       show this help`;

const args = process.argv.slice(2);
let port = 4777;
let open = true;
let target: string | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-p" || a === "--port") port = Number(args[++i]);
  else if (a === "--no-open") open = false;
  else if (a.startsWith("-")) {
    console.error(`Unknown option ${a}\n\n${HELP}`);
    process.exit(1);
  } else target = a;
}

let repo: string | undefined;
if (target) {
  try {
    repo = await resolveRepo(target);
    await pushRecent(repo);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const server = start({ port, initialRepo: repo, serveStatic: true });
const url = `http://127.0.0.1:${server.port}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
console.log(`gitui running at ${url}`);
if (open) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], {
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32",
  }).unref();
}
