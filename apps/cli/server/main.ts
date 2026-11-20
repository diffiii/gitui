import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PORT, pairingUrl } from "@gitui/shared";
import { type AppOptions, CONFIG_DIR, createApp } from "./app.ts";
import { loadToken } from "./token.ts";

// The built @gitui/web app (a workspace dependency), served in production.
const DIST = path.join(
  path.dirname(Bun.resolveSync("@gitui/web/package.json", import.meta.dir)),
  "dist",
);

export interface StartOptions extends AppOptions {
  port: number;
  /** Serve the built frontend from apps/web/dist (production). In dev, Vite serves it. */
  serveStatic: boolean;
}

/** Serves on the first free port from `opts.port` and returns that port. */
export function start(opts: StartOptions): number {
  const app = createApp(opts);

  if (opts.serveStatic) {
    if (!existsSync(DIST)) {
      console.error("apps/web/dist not found — run `vp build` first (or use `bun run dev`).");
      process.exit(1);
    }
    app.get("*", async (c) => {
      const rel = path
        .normalize(decodeURIComponent(new URL(c.req.url).pathname))
        .replace(/^(\.\.[/\\])+/, "");
      const file = Bun.file(path.join(DIST, rel));
      if (rel !== "/" && (await file.exists())) return new Response(file);
      return new Response(Bun.file(path.join(DIST, "index.html")));
    });
  }

  for (let port = opts.port; port < opts.port + 20; port++) {
    try {
      Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 });
      return port;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port in range ${opts.port}-${opts.port + 19}`);
}

if (import.meta.main) {
  // Dev API server; Vite (vp dev) proxies /api here. GITUI_ALLOW_ORIGIN lets a web app served
  // elsewhere call it cross-origin, the way the hosted app calls the CLI.
  const extraOrigin = process.env.GITUI_ALLOW_ORIGIN;
  const token = await loadToken(CONFIG_DIR);
  const port = start({
    port: Number(process.env.GITUI_PORT ?? DEFAULT_PORT),
    initialRepo: process.env.GITUI_REPO,
    serveStatic: false,
    allowedOrigins: extraOrigin ? [extraOrigin] : [],
    token,
  });
  console.log(`gitui api on http://127.0.0.1:${port}`);
  if (extraOrigin) console.log(`pairing link: ${pairingUrl(extraOrigin, { port, token })}`);
}
