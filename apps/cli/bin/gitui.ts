#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import { HOSTED_ORIGIN, pairingUrl, RENDEZVOUS_ORIGIN, rendezvousUrl } from "@gitui/shared";
import { loopbackListener } from "../server/access.ts";
import { createApp } from "../server/app.ts";
import { pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { start } from "../server/main.ts";
import { startNearby } from "../server/nearby/host.ts";
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
const { port, open, origins, target } = options;

/** The rendezvous URL for --nearby, checked before anything starts. */
function nearbyUrl() {
  const url = rendezvousUrl(process.env.GITUI_RENDEZVOUS_URL || RENDEZVOUS_ORIGIN);
  return url ?? fail("GITUI_RENDEZVOUS_URL must be a ws: or wss: origin, e.g. ws://localhost:8787");
}
const nearby = options.nearby ? { ...options.nearby, url: nearbyUrl() } : null;

let repo: string | undefined;
if (target) {
  try {
    repo = await resolveRepo(target);
    await pushRecent(repo);
  } catch (e) {
    fail((e as Error).message);
  }
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

// Serves on 127.0.0.1 for the hosted app and `origins`.
const listener = await loopbackListener([HOSTED_ORIGIN, ...origins]);
const bound = await start({ port, initialRepo: repo, listener }).catch((e: Error) =>
  fail(`Can't listen on 127.0.0.1: ${e.message}`),
);
const pairing = pairingUrl(HOSTED_ORIGIN, { port: bound, token: listener.token });
console.log(`pairing link: ${pairing}`);
if (nearby) listenNearby(nearby);
if (open) openBrowser(pairing);

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
