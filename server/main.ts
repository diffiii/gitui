import { existsSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.ts";

const DIST = path.resolve(import.meta.dir, "../dist");

export interface StartOptions {
  port: number;
  initialRepo?: string;
  /** Serve the built frontend from dist/ (production). In dev, Vite serves it. */
  serveStatic: boolean;
}

export function start(opts: StartOptions) {
  const app = createApp({ initialRepo: opts.initialRepo });

  if (opts.serveStatic) {
    if (!existsSync(DIST)) {
      console.error("dist/ not found — run `vp build` first (or use `bun run dev`).");
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
      return Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 });
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port in range ${opts.port}-${opts.port + 19}`);
}

if (import.meta.main) {
  // Dev API server; Vite (vp dev) proxies /api here.
  const server = start({
    port: Number(process.env.GITUI_PORT ?? 4777),
    initialRepo: process.env.GITUI_REPO,
    serveStatic: false,
  });
  console.log(`gitui api on http://127.0.0.1:${server.port}`);
}
