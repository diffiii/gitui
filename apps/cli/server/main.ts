import { once } from "node:events";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { listenAddress } from "./access.ts";
import { type AppOptions, createApp } from "./app.ts";

export interface StartOptions extends AppOptions {
  /** First port to try. */
  port: number;
  /** Directory of the built UI to serve at `/`. Omitted, only the API is served. */
  ui?: string;
}

/**
 * Serves the built UI in `root`: files as they are (serveStatic refuses `..` segments), and
 * index.html for extension-less paths, which are client-side routes. A missing asset 404s.
 */
export function serveUi(app: ReturnType<typeof createApp>, root: string) {
  const index = serveStatic({ root, path: "index.html" });
  app.get("*", serveStatic({ root }), (c, next) =>
    path.extname(c.req.path) ? next() : index(c, next),
  );
}

/**
 * Serves on the first free port from `opts.port`, at the listener's address. Returns the bound
 * port, which the pairing link needs.
 */
export async function start({ port: first, ui, ...opts }: StartOptions): Promise<number> {
  const app = createApp(opts);
  if (ui) serveUi(app, ui);
  for (let port = first; port < first + 20; port++) {
    // Node's requestTimeout and headersTimeout only cover receiving the request, and
    // server.timeout is 0, so long git responses (fetches, pushes) aren't cut off.
    const server = createAdaptorServer({ fetch: app.fetch });
    server.listen(port, listenAddress(opts.listener));
    try {
      await once(server, "listening");
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port in range ${first}-${first + 19}`);
}
