import { defineConfig } from "vite-plus";

// Workspace-wide format, lint and type check settings. The app's Vite config lives in
// apps/web/vite.config.ts; bare `vp dev` / `vp build` at the root target it.
export default defineConfig({
  defaultPackage: "./apps/web",
  fmt: {},
  lint: {
    plugins: ["react", "typescript", "oxc"],
    ignorePatterns: ["**/dist/**"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  },
});
