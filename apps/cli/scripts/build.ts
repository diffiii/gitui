// Builds what the npm package ships besides README.md: the CLI bundled for Node (dist/gitui.js)
// and the repo's LICENSE. Run from apps/cli.
import fs from "node:fs";

fs.rmSync("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["bin/gitui.ts"],
  target: "node",
  outdir: "dist",
  naming: "gitui.js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
fs.copyFileSync("../../LICENSE", "LICENSE");
