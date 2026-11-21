// Dev API server; Vite (vp dev) proxies /api here. GITUI_ALLOW_ORIGIN lets a web app served
// elsewhere call it cross-origin, the way the hosted app calls the CLI.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { DEFAULT_PORT, pairingUrl } from "@gitui/shared";
import { Console, Effect } from "effect";
import { loopbackListener, parseOrigin } from "./access.ts";
import { start } from "./main.ts";

const main = Effect.gen(function* () {
  const raw = process.env.GITUI_ALLOW_ORIGIN;
  const extraOrigin = parseOrigin(raw);
  if (raw && !extraOrigin) return yield* Effect.die(`GITUI_ALLOW_ORIGIN is not an origin: ${raw}`);
  const listener = yield* loopbackListener(extraOrigin ? [extraOrigin] : []);
  const port = yield* start({
    port: Number(process.env.GITUI_PORT ?? DEFAULT_PORT),
    initialRepo: process.env.GITUI_REPO,
    listener,
  });
  yield* Console.log(`gitui api on http://127.0.0.1:${port}`);
  if (extraOrigin) {
    yield* Console.log(`pairing link: ${pairingUrl(extraOrigin, { port, token: listener.token })}`);
  }
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
