#!/usr/bin/env node
import { spawn } from "node:child_process";
import { DEFAULT_PORT, HOSTED_ORIGIN, pairingUrl } from "@gitui/shared";
import { parseOrigin } from "../server/access.ts";
import { pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { start } from "../server/main.ts";

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
    const origin = parseOrigin(args[++i]);
    if (!origin) fail(`--allow-origin needs an origin, e.g. http://localhost:5173`);
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

const bound = await start({ port, initialRepo: repo, serveStatic: !hosted, allowedOrigins });
const pairing = pairingUrl(HOSTED_ORIGIN, bound);
const local = `http://127.0.0.1:${bound.port}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
if (!hosted) console.log(`gitui running at ${local}`);
console.log(`hosted app: ${pairing}`);
const url = hosted ? pairing : local;
if (open) {
  // No shell: the pairing link's `&` would split a cmd.exe command line.
  const [cmd, ...cmdArgs] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler"]
        : ["xdg-open"];
  spawn(cmd, [...cmdArgs, url], { stdio: "ignore", detached: true }).unref();
}
