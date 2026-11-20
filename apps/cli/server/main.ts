import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type AppOptions, createApp } from "./app.ts";
import { loadToken } from "./config.ts";

// The built web UI, which `bun run build` copies into this package's dist/web. This module is
// one level below the package root both as source (server/) and bundled (dist/).
const UI_DIR = path.join(import.meta.dirname, "../dist/web");

export interface StartOptions extends Omit<AppOptions, "token"> {
  port: number;
  /** Serve the built UI from dist/web (production). In dev, Vite serves it. */
  serveStatic: boolean;
}

/**
 * Serves on the first free port from `opts.port`, with the pairing token from the config dir.
 * Returns the bound port and the token, which the pairing link needs.
 */
export async function start(opts: StartOptions): Promise<{ port: number; token: string }> {
  const token = await loadToken();
  const app = createApp({ ...opts, token });

  if (opts.serveStatic) {
    if (!existsSync(UI_DIR)) {
      console.error(`${UI_DIR} not found — run \`bun run build\` first (or use --hosted).`);
      process.exit(1);
    }
    // Files from the UI dir (serveStatic refuses `..` segments), anything else gets index.html.
    app.get("*", serveStatic({ root: UI_DIR }), serveStatic({ root: UI_DIR, path: "index.html" }));
  }

  for (let port = opts.port; port < opts.port + 20; port++) {
    // Node's defaults don't time out a slow response (server.timeout is 0), so long fetches
    // and pushes can finish.
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
