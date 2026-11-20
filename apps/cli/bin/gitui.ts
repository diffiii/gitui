#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_PORT, HOSTED_ORIGIN, pairingUrl } from "@gitui/shared";
import { renderUnicodeCompact } from "uqr";
import {
  type Listener,
  lanListener,
  lanPairingUrl,
  listenAddress,
  loopbackListener,
  parseOrigin,
} from "../server/access.ts";
import { pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { lanAddresses, PRIVATE_RANGES, pickLanAddress } from "../server/lan.ts";
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
  --lan [address]         serve the bundled UI on your network, for a phone or another device.
                          The address is an IPv4 address of this machine (default: the default
                          route's, if it is private). Prints a link and QR code and never opens
                          a browser; the session travels over plain HTTP
  --allow-origin <origin> also let the web app at <origin> call the API (repeatable)
  --no-open               don't open the browser
  -h, --help              show this help`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Which UI gitui serves, and where. */
type Mode = { kind: "hosted" } | { kind: "local" } | { kind: "lan"; address?: string };

const args = process.argv.slice(2);
let port = DEFAULT_PORT;
let open = true;
let mode: Mode = { kind: "hosted" };
const extraOrigins: string[] = [];
let target: string | undefined;

/** The mode after a mode flag: `next`, unless another flag has chosen another mode already. */
function switchMode(current: Mode, next: Mode): Mode {
  if (current.kind !== "hosted" && current.kind !== next.kind) {
    fail("--local and --lan can't be combined");
  }
  return next;
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-p" || a === "--port") port = Number(args[++i]);
  else if (a === "--no-open") open = false;
  else if (a === "--local") mode = switchMode(mode, { kind: "local" });
  else if (a === "--lan") {
    // The address is optional: an IPv4 address after --lan is taken as one, anything else that
    // looks like an address is refused rather than taken as the repository path.
    const next = args[i + 1] ?? "";
    const address = net.isIPv4(next) ? args[++i] : undefined;
    if (!address && (net.isIPv6(next) || /^\d+(\.\d+)+$/.test(next))) {
      fail(`--lan takes an IPv4 address of this machine, not ${next}`);
    }
    if (address === "0.0.0.0") fail("--lan needs this machine's address, not 0.0.0.0");
    mode = switchMode(mode, { kind: "lan", address });
  } else if (a === "--allow-origin") {
    const origin = parseOrigin(args[++i]);
    if (!origin) fail(`--allow-origin needs an origin, e.g. http://localhost:5173`);
    extraOrigins.push(origin);
  } else if (a.startsWith("-")) fail(`Unknown option ${a}\n\n${HELP}`);
  else target = a;
}

if (mode.kind === "lan" && extraOrigins.length) {
  fail("--allow-origin doesn't apply to --lan, which serves its own UI only");
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

/** The UI that `bun run build` copies into dist/web. */
function bundledUi() {
  // This file sits one level below the package root both as source (bin/gitui.ts) and bundled
  // (dist/gitui.js), so one relative path works.
  const ui = path.join(import.meta.dirname, "../dist/web");
  if (!existsSync(ui)) fail(`${ui} not found — run \`bun run build\` first.`);
  return ui;
}

/** Starts the server and returns the bound port, or exits with why it couldn't. */
const listen = (listener: Listener, ui?: string) =>
  start({ port, initialRepo: repo, ui, listener }).catch((e: Error) =>
    fail(`Can't listen on ${listenAddress(listener)}: ${e.message}`),
  );

switch (mode.kind) {
  case "hosted":
  case "local": {
    const listener = await loopbackListener([HOSTED_ORIGIN, ...extraOrigins]);
    const local = mode.kind === "local";
    const bound = await listen(listener, local ? bundledUi() : undefined);
    const pairing = pairingUrl(HOSTED_ORIGIN, { port: bound, token: listener.token });
    console.log(`pairing link: ${pairing}`);
    let url = pairing;
    if (local) {
      url = `http://127.0.0.1:${bound}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
      console.log(`gitui running at ${url}`);
    }
    if (open) openBrowser(url);
    break;
  }
  case "lan": {
    const ui = bundledUi();
    const address = mode.address ?? (await pickLanAddress());
    if (!address) {
      const found = lanAddresses();
      fail(
        `No private network address found (${PRIVATE_RANGES.join(", ")}); pass this machine's address with --lan <address>.` +
          (found.length ? `\nAddresses of this machine: ${found.join(", ")}` : ""),
      );
    }
    const listener = lanListener(address);
    const link = lanPairingUrl(listener, await listen(listener, ui));
    console.log(`pairing link: ${link}\n\n${qrCode(link)}\n`);
    console.log("Open the link or scan the code on a device on this network.");
    const others = lanAddresses().filter((a) => a !== address);
    if (!mode.address && others.length) {
      console.log(`Other addresses of this machine: ${others.join(", ")} (use --lan <address>)`);
    }
    console.log(
      "Warning: the link and session travel over plain HTTP; use trusted networks only (home Wi-Fi or a hotspot, not public Wi-Fi).",
    );
    break;
  }
}

/**
 * `text` as a QR code in half-block characters. uqr draws light modules with the glyphs and
 * leaves dark ones as background, which only reads right on a dark background, so a terminal
 * gets explicit colours: bright white glyphs on black.
 */
function qrCode(text: string) {
  const qr = renderUnicodeCompact(text, { border: 2 });
  if (!process.stdout.isTTY) return qr;
  return qr
    .split("\n")
    .map((line) => `\x1b[97;40m${line}\x1b[0m`)
    .join("\n");
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
