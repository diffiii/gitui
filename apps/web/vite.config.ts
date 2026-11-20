import path from "node:path";
import { hostedHeadersFile, LOCAL_UI_META } from "@gitui/shared";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";

const API_PORT = Number(process.env.GITUI_PORT ?? 4777);

/**
 * Marks pages from the dev server as served by gitui, so they call `/api` through the proxy. Only
 * when serving: the build is the hosted app, which must pair instead.
 */
const localUiMarker: Plugin = {
  name: "gitui-local-ui",
  apply: "serve",
  transformIndexHtml: () => [{ tag: "meta", attrs: { name: LOCAL_UI_META }, injectTo: "head" }],
};

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

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    proxy: { "/api": `http://127.0.0.1:${API_PORT}` },
  },
  plugins: lazyPlugins(() => [react(), tailwindcss(), localUiMarker, hostedHeaders()]),
});
