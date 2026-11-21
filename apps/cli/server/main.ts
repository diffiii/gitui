import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { HOSTED_ORIGIN } from "@gitui/shared";
import { Cause, Data, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { LoopbackListener } from "./access.ts";
import { type AppOptions, createApp } from "./app.ts";

export interface StartOptions extends AppOptions {
  /** First port to try. */
  port: number;
  listener: LoopbackListener;
}

/** No port in the range was free, or listening failed otherwise. */
export class ListenError extends Data.TaggedError("ListenError")<{ message: string }> {}

/**
 * The app `start` serves: the API, and at `/` a note on where the UI is, for someone who opens
 * the server's address in a browser.
 */
export function serverApp(opts: AppOptions & { listener: LoopbackListener }) {
  return createApp(opts, [
    {
      method: "GET",
      path: "/",
      handle: Effect.succeed(
        HttpServerResponse.text(`This is the gitui API. The app is at ${HOSTED_ORIGIN}\n`),
      ),
    },
  ]);
}

const PORTS_TRIED = 20;

/**
 * Serves on the first free port from `opts.port`, on 127.0.0.1, until the scope closes. Returns
 * the bound port, which the pairing link needs.
 */
export const start = Effect.fnUntraced(function* ({ port: first, ...opts }: StartOptions) {
  const app = serverApp(opts);
  const scope = yield* Effect.scope;
  for (let port = first; port < first + PORTS_TRIED; port++) {
    // Node's requestTimeout and headersTimeout only cover receiving the request, and
    // server.timeout is 0, so long git responses (fetches, pushes) aren't cut off.
    const server = HttpRouter.serve(app.layer, {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host: "127.0.0.1" })));
    // Each try in a scope of its own, closed at once if it fails, so a busy port leaves nothing.
    const attempt = yield* Scope.fork(scope);
    const exit = yield* Effect.exit(Layer.buildWithScope(server, attempt));
    if (Exit.isSuccess(exit)) return port;
    yield* Scope.close(attempt, exit);
    const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
    const cause = error?.cause as NodeJS.ErrnoException | undefined;
    if (cause?.code !== "EADDRINUSE") {
      return yield* new ListenError({ message: cause?.message ?? Cause.pretty(exit.cause) });
    }
  }
  return yield* new ListenError({
    message: `No free port in range ${first}-${first + PORTS_TRIED - 1}`,
  });
});
