#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_PORT, HOSTED_ORIGIN, pairingUrl } from "@gitui/shared";
import { renderUnicodeCompact } from "uqr";
import { lanListener, lanPairingUrl, parseOrigin } from "../server/access.ts";
import { loadToken, pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { lanAddresses, pickLanAddress } from "../server/lan.ts";
import { start } from "../server/main.ts";

const HELP = `gitui — git in your browser

Usage:
  gitui            start the app with a repository picker
  gitui <path>     open the repository containing <path> (e.g. \`gitui .\`)

By default gitui serves only the API and opens the hosted app (${HOSTED_ORIGIN}),
paired with this machine through the printed link.

Options:
  -p, --port <n>          port to listen on (default ${DEFAULT_PORT})
  --local                 serve the UI bundled with gitui and open it instead (for browsers
                          that block the hosted app from reaching localhost, or offline use)
  --lan [address]         serve the bundled UI on your network, for a phone or another device
                          (default address: this machine's IPv4 address on the default route).
                          Prints a link and QR code; the session travels over plain HTTP
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
let local = false;
/** `--lan`: true picks the address. */
let lan: string | boolean = false;
const allowedOrigins = [HOSTED_ORIGIN];
let target: string | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-p" || a === "--port") port = Number(args[++i]);
  else if (a === "--no-open") open = false;
  else if (a === "--local") local = true;
  else if (a === "--lan") {
    // The address is optional, so only an IPv4 address after --lan is taken as one.
    lan = net.isIPv4(args[i + 1] ?? "") ? args[++i] : true;
    if (lan === "0.0.0.0") fail("--lan needs this machine's address, not 0.0.0.0");
  } else if (a === "--allow-origin") {
    const origin = parseOrigin(args[++i]);
    if (!origin) fail(`--allow-origin needs an origin, e.g. http://localhost:5173`);
    allowedOrigins.push(origin);
  } else if (a.startsWith("-")) fail(`Unknown option ${a}\n\n${HELP}`);
  else target = a;
}

if (lan && allowedOrigins.length > 1) fail("--allow-origin doesn't apply to --lan");

let repo: string | undefined;
if (target) {
  try {
    repo = await resolveRepo(target);
    await pushRecent(repo);
  } catch (e) {
    fail((e as Error).message);
  }
}

// The UI that `bun run build` copies into dist/web. This file sits one level below the package
// root both as source (bin/gitui.ts) and bundled (dist/gitui.js), so one relative path works.
let ui: string | undefined;
if (local || lan) {
  ui = path.join(import.meta.dirname, "../dist/web");
  if (!existsSync(ui)) fail(`${ui} not found — run \`bun run build\` first.`);
}

if (lan) {
  const address = lan === true ? await pickLanAddress() : lan;
  if (!address) fail("No network address found; pass one with --lan <address>.");
  const listener = lanListener(address);
  const bound = await start({ port, initialRepo: repo, ui, listener }).catch((e: Error) =>
    fail(`Can't listen on ${address}: ${e.message}`),
  );
  const link = lanPairingUrl(listener, bound);
  console.log(`pairing link: ${link}\n\n${renderUnicodeCompact(link)}\n`);
  console.log("Open the link or scan the code on a device on this network.");
  const others = lanAddresses().filter((a) => a !== address);
  if (lan === true && others.length) {
    console.log(`Other addresses of this machine: ${others.join(", ")} (use --lan <address>)`);
  }
  console.log(
    "Warning: the link and session travel over plain HTTP; use trusted networks only (home Wi-Fi or a hotspot, not public Wi-Fi).",
  );
} else {
  const token = await loadToken();
  const bound = await start({
    port,
    initialRepo: repo,
    ui,
    listener: { kind: "loopback", allowedOrigins, token },
  });
  const pairing = pairingUrl(HOSTED_ORIGIN, { port: bound, token });
  console.log(`pairing link: ${pairing}`);
  let url = pairing;
  if (local) {
    url = `http://127.0.0.1:${bound}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
    console.log(`gitui running at ${url}`);
  }
  if (open) openBrowser(url);
}

function openBrowser(url: string) {
  // No shell: the pairing link's `&` would split a cmd.exe command line.
  const [cmd, ...cmdArgs] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler"]
        : ["xdg-open"];
  spawn(cmd, [...cmdArgs, url], { stdio: "ignore", detached: true }).unref();
}
