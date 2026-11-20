// Builds what the npm package ships: the CLI bundled for Node (dist/gitui.js), a copy of the
// built UI (dist/web, marked as served by gitui itself) and the repo's LICENSE. Run from apps/cli
// after building apps/web.
import fs from "node:fs";
import { copyLocalUi } from "./local-ui.ts";

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
copyLocalUi("../web/dist", "dist/web");
fs.copyFileSync("../../LICENSE", "LICENSE");
