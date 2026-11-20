// Dev API server; Vite (vp dev) proxies /api here. GITUI_ALLOW_ORIGIN lets a web app served
// elsewhere call it cross-origin, the way the hosted app calls the CLI.
import { DEFAULT_PORT, pairingUrl } from "@gitui/shared";
import { loopbackListener, parseOrigin } from "./access.ts";
import { start } from "./main.ts";

const raw = process.env.GITUI_ALLOW_ORIGIN;
const extraOrigin = parseOrigin(raw);
if (raw && !extraOrigin) throw new Error(`GITUI_ALLOW_ORIGIN is not an origin: ${raw}`);
const listener = await loopbackListener(extraOrigin ? [extraOrigin] : []);
const port = await start({
  port: Number(process.env.GITUI_PORT ?? DEFAULT_PORT),
  initialRepo: process.env.GITUI_REPO,
  listener,
});
console.log(`gitui api on http://127.0.0.1:${port}`);
if (extraOrigin) {
  console.log(`pairing link: ${pairingUrl(extraOrigin, { port, token: listener.token })}`);
}
