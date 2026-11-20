import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serveUi, UI_HEADERS } from "../server/main.ts";
import { removeTempDirs, testApp, tmpDir, write } from "../server/test-repo.ts";
import { copyLocalUi } from "./local-ui.ts";

afterAll(removeTempDirs);

test("the copy's index.html gets the local UI marker, the source doesn't", () => {
  const from = tmpDir();
  const html = "<html><head><title>gitui</title></head><body></body></html>";
  write(from, "index.html", html);
  write(from, "assets/app.js", "console.log(1)");
  write(from, "_headers", "/*\n  X-Content-Type-Options: nosniff\n");
  const to = path.join(tmpDir(), "web");

  copyLocalUi(from, to);

  expect(fs.readFileSync(path.join(to, "index.html"), "utf8")).toBe(
    '<html><head><title>gitui</title><meta name="gitui-local-ui" />\n</head><body></body></html>',
  );
  expect(fs.readFileSync(path.join(to, "assets/app.js"), "utf8")).toBe("console.log(1)");
  expect(fs.readFileSync(path.join(from, "index.html"), "utf8")).toBe(html);
  expect(fs.existsSync(path.join(to, "_headers"))).toBe(false);
});

test("the CLI serves its UI with the hosted app's headers, connecting to itself only", async () => {
  const hosted = fs.readFileSync(path.join(import.meta.dir, "../../web/public/_headers"), "utf8");
  const expected = Object.fromEntries(
    hosted
      .split("\n")
      .filter((line) => /^\s+\S/.test(line))
      .map((line) => line.trim().split(/:\s*(.*)/) as [string, string])
      .map(([name, value]) =>
        name === "Content-Security-Policy"
          ? [name, value.replace(/connect-src [^;]*/, "connect-src 'self'")]
          : [name, value],
      ),
  );
  expect(UI_HEADERS).toEqual(expected);

  const root = tmpDir();
  write(root, "index.html", "<html></html>");
  const app = testApp();
  serveUi(app, root);
  for (const url of ["/", "/index.html", "/some/route"]) {
    const res = await app.request(`http://localhost${url}`);
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(UI_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  }
});
