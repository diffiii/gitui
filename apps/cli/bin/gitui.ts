#!/usr/bin/env node
import os from "node:os";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { HOSTED_ORIGIN, pairingUrl, RENDEZVOUS_ORIGIN, rendezvousUrl } from "@gitui/shared";
import { Console, Data, Effect } from "effect";
import { loopbackListener } from "../server/access.ts";
import { createApp, toFetch } from "../server/app.ts";
import { pushRecent } from "../server/config.ts";
import { resolveRepo } from "../server/git.ts";
import { start } from "../server/main.ts";
import { startNearby } from "../server/nearby/host.ts";
import { ArgsError, HELP, hostnameAsName, type Nearby, parseArgs } from "./args.ts";
import { openBrowser } from "./open.ts";

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
 * Lists this machine for phones on the network until gitui stops; their requests go to an app of
 * their own, whose access rules trust the authenticated data channel (see server/access.ts).
 */
const listenNearby = ({ name, url }: Nearby & { url: string }, repo: string | undefined) =>
  Effect.flatMap(toFetch(createApp({ listener: { kind: "nearby" }, initialRepo: repo })), (fetch) =>
    startNearby({
      url,
      name: name ?? hostnameAsName(os.hostname()),
      fetch,
      log: (line) => console.log(line),
    }),
  );

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
  if (nearby) yield* listenNearby(nearby, repo);
  if (open) {
    openBrowser(pairing, () =>
      console.log("Couldn't open a browser: open the pairing link above yourself."),
    );
  }
  return yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.catchTag("CliError", (e) =>
    Console.error(e.message).pipe(Effect.andThen(Effect.sync(() => process.exit(1)))),
  ),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(main);
