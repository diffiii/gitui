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
    overrides: [
      {
        // The CLI ships as a Node bundle, so its runtime code can't use Bun's APIs.
        files: ["apps/cli/bin/**", "apps/cli/server/**"],
        rules: {
          "no-restricted-globals": [
            "error",
            { name: "Bun", message: "The CLI runs on Node too; use node: APIs." },
          ],
        },
      },
      {
        // Tests, their fixtures and the dev server only ever run under Bun.
        files: ["apps/cli/**/*.test.ts", "apps/cli/server/test-repo.ts", "apps/cli/server/dev.ts"],
        rules: { "no-restricted-globals": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  },
});
