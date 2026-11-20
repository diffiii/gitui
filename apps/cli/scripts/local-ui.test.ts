import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { removeTempDirs, tmpDir, write } from "../server/test-repo.ts";
import { copyLocalUi } from "./local-ui.ts";

afterAll(removeTempDirs);

test("the copy's index.html gets the local UI marker, the source doesn't", () => {
  const from = tmpDir();
  const html = "<html><head><title>gitui</title></head><body></body></html>";
  write(from, "index.html", html);
  write(from, "assets/app.js", "console.log(1)");
  const to = path.join(tmpDir(), "web");

  copyLocalUi(from, to);

  expect(fs.readFileSync(path.join(to, "index.html"), "utf8")).toBe(
    '<html><head><title>gitui</title><meta name="gitui-local-ui" />\n</head><body></body></html>',
  );
  expect(fs.readFileSync(path.join(to, "assets/app.js"), "utf8")).toBe("console.log(1)");
  expect(fs.readFileSync(path.join(from, "index.html"), "utf8")).toBe(html);
});
