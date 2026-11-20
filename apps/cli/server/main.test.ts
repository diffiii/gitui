import { afterAll, expect, test } from "bun:test";
import { uiSecurityHeaders } from "@gitui/shared";
import { serveUi } from "./main.ts";
import { removeTempDirs, testApp, tmpDir, write } from "./test-repo.ts";

afterAll(removeTempDirs);

const ui = tmpDir();
write(ui, "index.html", '<div id="root"></div>');
write(ui, "assets/app.js", "console.log(1)");

const api = testApp();
const withUi = testApp();
serveUi(withUi, ui);

const get = (app: typeof api, url: string, headers: Record<string, string> = {}) =>
  app.request(url, { headers: { host: "localhost", ...headers } });

test("an unknown API route is a JSON 404, with or without the UI", async () => {
  for (const app of [api, withUi]) {
    const res = await get(app, "/api/nope", { "x-gitui": "1" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  }
});

test("the API alone serves nothing at /", async () => {
  expect((await get(api, "/")).status).toBe(404);
});

test("the UI serves files and falls back to index.html for client routes", async () => {
  expect(await (await get(withUi, "/assets/app.js")).text()).toBe("console.log(1)");
  for (const url of ["/", "/some/route"]) {
    const res = await get(withUi, url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  }
});

test("a missing asset 404s instead of returning index.html", async () => {
  const res = await get(withUi, "/assets/missing.js");
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain('<div id="root">');
});

test("the UI is served with the security headers, connecting to its own origin only", async () => {
  const headers = uiSecurityHeaders("'self'");
  expect(headers["Content-Security-Policy"]).toContain("connect-src 'self';");
  for (const url of ["/", "/index.html", "/some/route", "/assets/app.js"]) {
    const res = await get(withUi, url);
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(headers)) expect(res.headers.get(name)).toBe(value);
  }
});
