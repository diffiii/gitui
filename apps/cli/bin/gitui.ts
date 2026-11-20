#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { DEFAULT_PORT, HOSTED_ORIGIN, pairingUrl } from "@gitui/shared";
import { CONFIG_DIR, pushRecent } from "../server/app.ts";
import { resolveRepo } from "../server/git.ts";
import { start } from "../server/main.ts";
import { loadToken } from "../server/token.ts";

const HELP = `gitui — git in your browser

Usage:
  gitui            start the app with a repository picker
  gitui <path>     open the repository containing <path> (e.g. \`gitui .\`)

Options:
  -p, --port <n>          port to listen on (default ${DEFAULT_PORT})
  --hosted                use the hosted app (${HOSTED_ORIGIN}) instead of serving the UI
  --allow-origin <origin> also let the web app at <origin> call the API (repeatable)
  --no-open               don't open the browser
  -h, --help              show this help`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
let port = DEFAULT_PORT;
let open = true;
let hosted = false;
const allowedOrigins = [HOSTED_ORIGIN];
let target: string | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-p" || a === "--port") port = Number(args[++i]);
  else if (a === "--no-open") open = false;
  else if (a === "--hosted") hosted = true;
  else if (a === "--allow-origin") {
    const origin = args[++i];
    if (URL.parse(origin)?.origin !== origin)
      fail(`--allow-origin needs an origin, e.g. http://localhost:5173`);
    allowedOrigins.push(origin);
  } else if (a.startsWith("-")) fail(`Unknown option ${a}\n\n${HELP}`);
  else target = a;
}

let repo: string | undefined;
if (target) {
  try {
    repo = await resolveRepo(target);
    await pushRecent(repo);
  } catch (e) {
    fail((e as Error).message);
  }
}

const token = await loadToken(CONFIG_DIR);
const bound = start({ port, initialRepo: repo, serveStatic: !hosted, allowedOrigins, token });
const pairing = pairingUrl(HOSTED_ORIGIN, { port: bound, token });
const local = `http://127.0.0.1:${bound}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
if (!hosted) console.log(`gitui running at ${local}`);
console.log(`hosted app: ${pairing}`);
const url = hosted ? pairing : local;
if (open) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], {
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32",
  }).unref();
}
