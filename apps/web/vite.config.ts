import path from "node:path";
import { LOCAL_UI_META } from "@gitui/shared";
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

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    proxy: { "/api": `http://127.0.0.1:${API_PORT}` },
  },
  plugins: lazyPlugins(() => [react(), tailwindcss(), localUiMarker]),
});
