// Builds what the npm package ships: the CLI bundled for Node (dist/gitui.js), a copy of the
// built UI (dist/web) and the repo's LICENSE. Run from apps/cli after building apps/web.
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
fs.cpSync("../web/dist", "dist/web", { recursive: true });
fs.copyFileSync("../../LICENSE", "LICENSE");
