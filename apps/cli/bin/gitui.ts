#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { HOSTED_ORIGIN, pairingUrl, RENDEZVOUS_ORIGIN, rendezvousUrl } from "@gitui/shared";
import { Console, Data, Effect } from "effect";
import { loopbackListener } from "../server/access.ts";
import { createApp } from "../server/app.ts";
import { pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { start } from "../server/main.ts";
import { startNearby } from "../server/nearby/host.ts";
import { ArgsError, HELP, hostnameAsName, type Nearby, parseArgs } from "./args.ts";

/** What gitui prints before it exits with 1. */
class CliError extends Data.TaggedError("CliError")<{ message: string }> {}

const fail = (message: string) => Effect.fail(new CliError({ message }));

/** The rendezvous URL for --nearby, checked before anything starts. */
const nearbyUrl = Effect.suspend(() => {
  const url = rendezvousUrl(process.env.GITUI_RENDEZVOUS_URL || RENDEZVOUS_ORIGIN);
  return url === null
    ? fail("GITUI_RENDEZVOUS_URL must be a ws: or wss: origin, e.g. ws://localhost:8787")
    : Effect.succeed(url);
});

/**
 * Lists this machine for phones on the network; their requests go to an app of their own, whose
 * access rules trust the authenticated data channel (see server/access.ts).
 */
function listenNearby({ name, url }: Nearby & { url: string }, repo: string | undefined) {
  const app = createApp({ listener: { kind: "nearby" }, initialRepo: repo });
  startNearby({
    url,
    name: name ?? hostnameAsName(os.hostname()),
    fetch: app.fetch,
    log: (line) => console.log(line),
  });
}

function openBrowser(url: string) {
  // No shell: the pairing link's `&` would split a cmd.exe command line. Detached and left to
  // run on its own, unlike the git processes, which end with the request that started them.
  const [cmd, ...cmdArgs] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler"]
        : ["xdg-open"];
  spawn(cmd, [...cmdArgs, url], { stdio: "ignore", detached: true }).unref();
}

const main = Effect.gen(function* () {
  const parsed = yield* Effect.suspend(() => {
    try {
      return Effect.succeed(parseArgs(process.argv.slice(2)));
    } catch (e) {
      if (e instanceof ArgsError) return fail(e.message);
      throw e;
    }
  });
  if (parsed === "help") return yield* Console.log(HELP);
  const { port, open, origins, target } = parsed;
  const nearby = parsed.nearby ? { ...parsed.nearby, url: yield* nearbyUrl } : null;

  let repo: string | undefined;
  if (target) {
    repo = yield* resolveRepo(target).pipe(Effect.mapError((e) => new CliError(e)));
    yield* pushRecent(repo).pipe(Effect.mapError((e) => new CliError(e)));
  }

  // Serves on 127.0.0.1 for the hosted app and `origins`, until gitui is stopped.
  const listener = yield* loopbackListener([HOSTED_ORIGIN, ...origins]);
  const bound = yield* start({ port, initialRepo: repo, listener }).pipe(
    Effect.mapError((e) => new CliError({ message: `Can't listen on 127.0.0.1: ${e.message}` })),
  );
  const pairing = pairingUrl(HOSTED_ORIGIN, { port: bound, token: listener.token });
  yield* Console.log(`pairing link: ${pairing}`);
  if (nearby) listenNearby(nearby, repo);
  if (open) openBrowser(pairing);
  return yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.catchTag("CliError", (e) =>
    Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => process.exit(1)))),
  ),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(main, { disableErrorReporting: false });
