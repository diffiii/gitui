import { once } from "node:events";
import { createAdaptorServer } from "@hono/node-server";
import { HOSTED_ORIGIN } from "@gitui/shared";
import type { LoopbackListener } from "./access.ts";
import { type AppOptions, createApp } from "./app.ts";

export interface StartOptions extends AppOptions {
  /** First port to try. */
  port: number;
  listener: LoopbackListener;
}

/**
 * The app `start` serves: the API, and at `/` a note on where the UI is, for someone who opens
 * the server's address in a browser.
 */
export function serverApp(opts: AppOptions) {
  const app = createApp(opts);
  app.get("/", (c) => c.text(`This is the gitui API. The app is at ${HOSTED_ORIGIN}\n`));
  return app;
}

/**
 * Serves on the first free port from `opts.port`, on 127.0.0.1. Returns the bound port, which
 * the pairing link needs.
 */
export async function start({ port: first, ...opts }: StartOptions): Promise<number> {
  const app = serverApp(opts);
  for (let port = first; port < first + 20; port++) {
    // Node's requestTimeout and headersTimeout only cover receiving the request, and
    // server.timeout is 0, so long git responses (fetches, pushes) aren't cut off.
    const server = createAdaptorServer({ fetch: app.fetch });
    server.listen(port, "127.0.0.1");
    try {
      await once(server, "listening");
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port in range ${first}-${first + 19}`);
}
