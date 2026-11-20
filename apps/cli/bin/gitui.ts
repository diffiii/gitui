#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOSTED_ORIGIN, pairingUrl } from "@gitui/shared";
import { renderUnicodeCompact } from "uqr";
import {
  type SocketListener,
  lanListener,
  lanPairingUrl,
  listenAddress,
  loopbackListener,
} from "../server/access.ts";
import { createApp } from "../server/app.ts";
import { pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { lanAddresses, PRIVATE_RANGES, pickLanAddress } from "../server/lan.ts";
import { start } from "../server/main.ts";
import { RENDEZVOUS_ORIGIN, rendezvousUrl, startNearby } from "../server/nearby/host.ts";
import { ArgsError, HELP, hostnameAsName, type Nearby, type Options, parseArgs } from "./args.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let options: Options;
try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    console.log(HELP);
    process.exit(0);
  }
  options = parsed;
} catch (e) {
  if (e instanceof ArgsError) fail(e.message);
  throw e;
}
const { port, open, mode, target } = options;

/** The rendezvous URL for --nearby, checked before anything starts. */
function nearbyUrl() {
  const url = rendezvousUrl(process.env.GITUI_RENDEZVOUS_URL || RENDEZVOUS_ORIGIN);
  return url ?? fail("GITUI_RENDEZVOUS_URL must be a ws: or wss: origin, e.g. ws://localhost:8787");
}
const nearby = mode.kind !== "lan" && mode.nearby ? { ...mode.nearby, url: nearbyUrl() } : null;

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
const listen = (listener: SocketListener, ui?: string) =>
  start({ port, initialRepo: repo, ui, listener }).catch((e: Error) =>
    fail(`Can't listen on ${listenAddress(listener)}: ${e.message}`),
  );

/** Serves on 127.0.0.1 for the hosted app and `origins`, and prints the pairing link. */
async function listenLoopback(origins: string[], ui?: string) {
  const listener = await loopbackListener([HOSTED_ORIGIN, ...origins]);
  const bound = await listen(listener, ui);
  const pairing = pairingUrl(HOSTED_ORIGIN, { port: bound, token: listener.token });
  console.log(`pairing link: ${pairing}`);
  return { bound, pairing };
}

/**
 * Lists this machine for phones on the network; their requests go to an app of their own, whose
 * access rules trust the authenticated data channel (see server/access.ts).
 */
function listenNearby({ name, url }: Nearby & { url: string }) {
  const app = createApp({ listener: { kind: "nearby" }, initialRepo: repo });
  startNearby({
    url,
    name: name ?? hostnameAsName(os.hostname()),
    fetch: app.fetch,
    log: (line) => console.log(line),
  });
}

switch (mode.kind) {
  case "hosted": {
    const { pairing } = await listenLoopback(mode.origins);
    if (nearby) listenNearby(nearby);
    if (open) openBrowser(pairing);
    break;
  }
  case "local": {
    const { bound } = await listenLoopback(mode.origins, bundledUi());
    const url = `http://127.0.0.1:${bound}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
    console.log(`gitui running at ${url}`);
    if (nearby) listenNearby(nearby);
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
 * gets explicit colours: white glyphs on black, from the 256-colour palette, which themes leave
 * alone (light themes often remap the 16 basic colours, white and black included).
 */
function qrCode(text: string) {
  const qr = renderUnicodeCompact(text, { border: 2 });
  if (!process.stdout.isTTY) return qr;
  return qr
    .split("\n")
    .map((line) => `\x1b[38;5;231;48;5;16m${line}\x1b[0m`)
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
