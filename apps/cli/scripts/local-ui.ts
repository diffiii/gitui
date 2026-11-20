import fs from "node:fs";
import path from "node:path";
import { LOCAL_UI_META } from "@gitui/shared";

/**
 * Copies the built UI from `from` to `to` and marks the copy's index.html with LOCAL_UI_META,
 * so it calls the CLI's own `/api`. `from` stays unmarked: it is what the hosted app deploys.
 * The hosting config `_headers` stays behind: the CLI sets those headers itself (`serveUi`).
 */
export function copyLocalUi(from: string, to: string) {
  const headers = path.join(from, "_headers");
  fs.cpSync(from, to, { recursive: true, filter: (src) => src !== headers });
  const index = path.join(to, "index.html");
  const html = fs.readFileSync(index, "utf8");
  if (!html.includes("</head>")) throw new Error(`${index} has no </head>`);
  fs.writeFileSync(index, html.replace("</head>", `<meta name="${LOCAL_UI_META}" />\n</head>`));
}
