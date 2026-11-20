import path from "node:path";
import { hostedHeadersFile } from "@gitui/shared";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";

// The dev API. Pages from the dev server call it through this proxy (`__GITUI_DEV_SERVER__` makes
// them `dev` connections, in src/lib/connection.ts); the build is the hosted app, which pairs.
const API_PORT = Number(process.env.GITUI_PORT ?? 4777);

/**
 * Emits the hosted app's `_headers` (its security headers on Cloudflare) into the build. Its CSP
 * lets the page reach the rendezvous the build talks to: VITE_GITUI_RENDEZVOUS_URL if set.
 */
const hostedHeaders = (): Plugin => {
  let rendezvous: string | undefined;
  return {
    name: "gitui-hosted-headers",
    apply: "build",
    configResolved(config) {
      rendezvous = config.env.VITE_GITUI_RENDEZVOUS_URL || undefined;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: hostedHeadersFile(rendezvous) });
    },
  };
};

/**
 * Defines `__GITUI_DEV_SERVER__`: true only on the dev server. It follows the command, not the
 * mode, so a build with NODE_ENV=development is still the hosted app, which pairs.
 */
const devServerFlag = (): Plugin => ({
  name: "gitui-dev-server-flag",
  config: (_, { command }) => ({
    define: { __GITUI_DEV_SERVER__: JSON.stringify(command === "serve") },
  }),
});

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    // Keep the page's Host, so the API sees its same-origin requests as such (POSTs carry Origin).
    proxy: { "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false } },
  },
  plugins: lazyPlugins(() => [react(), tailwindcss(), hostedHeaders(), devServerFlag()]),
});
