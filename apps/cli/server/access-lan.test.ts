import { expect, test } from "bun:test";
import { type LanListener, lanListener, lanPairingUrl } from "./access.ts";
import { createApp } from "./app.ts";

const listener: LanListener = {
  kind: "lan",
  address: "192.168.1.5",
  secret: "lan-secret",
  cookie: "gitui-session-a1",
};
const app = createApp({ listener });
const HOST = "192.168.1.5:4777";
const SESSION = "gitui-session-a1=lan-secret";

const get = (url: string, headers: Record<string, string>) =>
  app.request(`http://${HOST}${url}`, { headers });
const api = (headers: Record<string, string>) => get("/api/config", { "x-gitui": "1", ...headers });

test("the pairing link carries the address, port and secret", () => {
  expect(lanPairingUrl(listener, 4777)).toBe("http://192.168.1.5:4777/pair?key=lan-secret");
});

test("each LAN listener gets its own secret and cookie name", () => {
  const [a, b] = [lanListener("192.168.1.5"), lanListener("192.168.1.5")];
  expect(a.secret).not.toBe(b.secret);
  expect(a.cookie).not.toBe(b.cookie);
  expect(a.cookie).toMatch(/^gitui-session-[0-9a-f]+$/);
  expect(Buffer.from(a.secret, "base64url")).toHaveLength(16);
});

/** The cookies a response sets, each as its sorted attributes. */
const setCookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split("; ").sort());

test("/pair with the key sets the session cookie for 30 days and redirects to the UI", async () => {
  const res = await get("/pair?key=lan-secret", { host: HOST });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(setCookies(res)).toEqual([
    ["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Strict", SESSION].sort(),
  ]);
});

test("/pair drops the session cookies of other runs, and leaves other cookies alone", async () => {
  const res = await get("/pair?key=lan-secret", {
    host: HOST,
    cookie: "gitui-session-old1=x; theme=dark; gitui-session-a1=stale; gitui-session-old2=y",
  });
  expect(res.status).toBe(302);
  const set = setCookies(res);
  expect(set).toHaveLength(3);
  for (const name of ["gitui-session-old1", "gitui-session-old2"]) {
    expect(set).toContainEqual(["Max-Age=0", "Path=/", `${name}=`].sort());
  }
  expect(set).toContainEqual(
    ["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Strict", SESSION].sort(),
  );
});

test("/pair with a wrong key drops no cookies", async () => {
  const res = await get("/pair?key=nope", { host: HOST, cookie: "gitui-session-old1=x" });
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie()).toEqual([]);
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
    { host: HOST, cookie: "gitui-session-a1=nope" },
    // The session of another gitui on this address.
    { host: HOST, cookie: "gitui-session-b2=lan-secret" },
  ];
  for (const headers of requests) {
    const res = await api(headers);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  }
});

test("the API is allowed with the session cookie on the LAN address, whatever the port", async () => {
  // A browser's Host carries the port it connected to; the cookie name tells instances apart.
  for (const host of [HOST, "192.168.1.5:4778", "192.168.1.5"]) {
    const res = await api({ host, origin: `http://${host}`, cookie: SESSION });
    expect(res.status).toBe(200);
  }
});

test("the API still needs the x-gitui header", async () => {
  const res = await get("/api/config", { host: HOST, cookie: SESSION });
  expect(res.status).toBe(403);
});

test("other hosts are refused, even with the session (DNS rebinding)", async () => {
  const hosts = ["evil.example:4777", "192.168.1.6:4777", "localhost:4777", "127.0.0.1:4777"];
  for (const host of hosts) {
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
