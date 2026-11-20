import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

const API_PORT = Number(process.env.GITUI_PORT ?? 4777);

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    proxy: { "/api": `http://127.0.0.1:${API_PORT}` },
  },
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
});
