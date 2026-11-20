import { afterAll, expect, test } from "bun:test";
import { type LanListener, lanPairingUrl } from "./access.ts";
import { createApp } from "./app.ts";
import { removeTempDirs } from "./test-repo.ts";

afterAll(removeTempDirs);

const listener: LanListener = { kind: "lan", address: "192.168.1.5", secret: "lan-secret" };
const app = createApp({ listener, port: 4777 });
const HOST = "192.168.1.5:4777";
const SESSION = "gitui-session-4777=lan-secret";

const get = (url: string, headers: Record<string, string>) =>
  app.request(`http://${HOST}${url}`, { headers });
const api = (headers: Record<string, string>) => get("/api/config", { "x-gitui": "1", ...headers });

test("the pairing link carries the address, port and secret", () => {
  expect(lanPairingUrl(listener, 4777)).toBe("http://192.168.1.5:4777/pair?key=lan-secret");
});

test("/pair with the key sets the session cookie and redirects to the UI", async () => {
  const res = await get("/pair?key=lan-secret", { host: HOST });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie.split("; ").sort()).toEqual(
    ["HttpOnly", "Path=/", "SameSite=Strict", SESSION].sort(),
  );
});

test("/pair with a wrong or missing key sets no cookie", async () => {
  for (const url of ["/pair?key=nope", "/pair"]) {
    const res = await get(url, { host: HOST });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  }
});

test("/pair from a foreign host sets no cookie", async () => {
  const res = await get("/pair?key=lan-secret", { host: "evil.example:4777" });
  expect(res.status).toBe(403);
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("the API needs the session cookie, same-origin requests included", async () => {
  const requests: Record<string, string>[] = [
    { host: HOST },
    { host: HOST, origin: `http://${HOST}` },
    { host: HOST, cookie: "gitui-session-4777=nope" },
    // The session of a gitui on another port of this address.
    { host: HOST, cookie: "gitui-session-4778=lan-secret" },
  ];
  for (const headers of requests) {
    const res = await api(headers);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  }
});

test("the API is allowed with the session cookie, on the LAN or loopback host", async () => {
  for (const host of [HOST, "127.0.0.1:4777", "localhost:4777"]) {
    const res = await api({ host, origin: `http://${host}`, cookie: SESSION });
    expect(res.status).toBe(200);
  }
});

test("the API still needs the x-gitui header", async () => {
  const res = await get("/api/config", { host: HOST, cookie: SESSION });
  expect(res.status).toBe(403);
});

test("other hosts are refused, even with the session (DNS rebinding)", async () => {
  for (const host of ["evil.example:4777", "192.168.1.5:4778", "192.168.1.5", "192.168.1.6:4777"]) {
    const res = await api({ host, cookie: SESSION });
    expect(res.status).toBe(403);
  }
});

test("cross-origin pages are refused, the hosted app and the pairing token included", async () => {
  for (const origin of ["https://gitui.diffiii.dev", "http://192.168.1.5:5173"]) {
    for (const method of ["GET", "OPTIONS"]) {
      const res = await app.request(`http://${HOST}/api/config`, {
        method,
        headers: { host: HOST, origin, "x-gitui": "1", cookie: SESSION },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  }
});
