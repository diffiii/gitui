import { once } from "node:events";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type AppOptions, createApp } from "./app.ts";
import { loadToken } from "./config.ts";

export interface StartOptions extends Omit<AppOptions, "token"> {
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
 * Serves on the first free port from `opts.port`, with the pairing token from the config dir.
 * Returns the bound port and the token, which the pairing link needs.
 */
export async function start(opts: StartOptions): Promise<{ port: number; token: string }> {
  const token = await loadToken();
  const app = createApp({ ...opts, token });
  if (opts.ui) serveUi(app, opts.ui);

  for (let port = opts.port; port < opts.port + 20; port++) {
    // Node's requestTimeout and headersTimeout only cover receiving the request, and
    // server.timeout is 0, so long git responses (fetches, pushes) aren't cut off.
    const server = createAdaptorServer({ fetch: app.fetch });
    server.listen(port, "127.0.0.1");
    try {
      await once(server, "listening");
      return { port, token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port in range ${opts.port}-${opts.port + 19}`);
}
