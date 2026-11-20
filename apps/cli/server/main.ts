import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PORT, pairingUrl } from "@gitui/shared";
import { parseOrigin } from "./access.ts";
import { type AppOptions, createApp } from "./app.ts";
import { loadToken } from "./config.ts";

// The built @gitui/web app (a workspace dependency), served in production.
const DIST = path.join(
  path.dirname(Bun.resolveSync("@gitui/web/package.json", import.meta.dir)),
  "dist",
);

export interface StartOptions extends Omit<AppOptions, "token"> {
  port: number;
  /** Serve the built frontend from apps/web/dist (production). In dev, Vite serves it. */
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
      return { port, token };
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port in range ${opts.port}-${opts.port + 19}`);
}

if (import.meta.main) {
  // Dev API server; Vite (vp dev) proxies /api here. GITUI_ALLOW_ORIGIN lets a web app served
  // elsewhere call it cross-origin, the way the hosted app calls the CLI.
  const raw = process.env.GITUI_ALLOW_ORIGIN;
  const extraOrigin = parseOrigin(raw);
  if (raw && !extraOrigin) throw new Error(`GITUI_ALLOW_ORIGIN is not an origin: ${raw}`);
  const { port, token } = await start({
    port: Number(process.env.GITUI_PORT ?? DEFAULT_PORT),
    initialRepo: process.env.GITUI_REPO,
    serveStatic: false,
    allowedOrigins: extraOrigin ? [extraOrigin] : [],
  });
  console.log(`gitui api on http://127.0.0.1:${port}`);
  if (extraOrigin) console.log(`pairing link: ${pairingUrl(extraOrigin, { port, token })}`);
}
