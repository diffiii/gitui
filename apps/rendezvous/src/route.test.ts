import { expect, test } from "bun:test";
import { HOSTED_ORIGIN, RENDEZVOUS_PATH } from "@gitui/shared";
import { isAllowedOrigin, networkKey, networkOf, route, type RouteEnv } from "./route.ts";

const SECRET = "test-secret";
const env = (extra: RouteEnv = {}): RouteEnv => ({ NETWORK_KEY_SECRET: SECRET, ...extra });

test("networkOf keeps the IPv4 address and the IPv6 /64", () => {
  expect(networkOf("203.0.113.7")).toBe("v4:203.0.113.7");
  expect(networkOf("2001:db8:0:1:aaaa:bbbb:cccc:dddd")).toBe("v6:2001:db8:0:1::/64");
});

test("networkOf gives compressed and full IPv6 forms the same /64", () => {
  const network = "v6:2001:db8:0:0::/64";
  expect(networkOf("2001:db8::1")).toBe(network);
  expect(networkOf("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe(network);
  expect(networkOf("2001:db8:0:0:ffff::")).toBe(network);
  expect(networkOf("::1")).toBe("v6:0:0:0:0::/64");
  expect(networkOf("fe80:1:2:3::")).toBe("v6:fe80:1:2:3::/64");
});

test("networkOf treats IPv4-mapped IPv6 as IPv4", () => {
  expect(networkOf("::ffff:203.0.113.7")).toBe("v4:203.0.113.7");
  expect(networkOf("::ffff:cb00:7107")).toBe("v4:203.0.113.7");
  expect(networkOf("0:0:0:0:0:ffff:203.0.113.7")).toBe("v4:203.0.113.7");
});

test("networkOf rejects anything that isn't an address", () => {
  for (const ip of [
    "",
    "localhost",
    "256.0.0.1",
    "1.2.3",
    "1.2.3.4.5",
    "1::2::3",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4::5:6:7:8",
    ":1:2:3:4:5:6:7",
    "12345::",
    "g::",
    "::ffff:1.2.3.256",
  ]) {
    expect(networkOf(ip)).toBeNull();
  }
});

test("networkKey is the HMAC-SHA256 of the network", async () => {
  const key = await networkKey("203.0.113.7", SECRET);
  expect(key).toMatch(/^[\da-f]{64}$/);
  expect(await networkKey("::ffff:203.0.113.7", SECRET)).toBe(key);
  expect(await networkKey("203.0.113.8", SECRET)).not.toBe(key);
  const v6 = await networkKey("2001:db8::1", SECRET);
  expect(await networkKey("2001:db8::ffff:2", SECRET)).toBe(v6);
  expect(await networkKey("2001:db8:0:1::1", SECRET)).not.toBe(v6);
  expect(await networkKey("nope", SECRET)).toBeNull();
});

test("networkKey depends on the secret", async () => {
  const key = await networkKey("203.0.113.7", SECRET);
  expect(await networkKey("203.0.113.7", "other-secret")).not.toBe(key);
  // Switching secrets back and forth doesn't reuse the wrong imported key.
  expect(await networkKey("203.0.113.7", SECRET)).toBe(key);
  const hmac = new Bun.CryptoHasher("sha256", SECRET).update("v4:203.0.113.7").digest("hex");
  expect(key).toBe(hmac);
});

test("isAllowedOrigin accepts the hosted origin and the listed ones", () => {
  expect(isAllowedOrigin(HOSTED_ORIGIN, undefined)).toBe(true);
  expect(isAllowedOrigin("http://localhost:5181", undefined)).toBe(false);
  expect(isAllowedOrigin("http://localhost:5181", "http://localhost:5181")).toBe(true);
  expect(isAllowedOrigin("http://localhost:5181", " http://a.test , http://localhost:5181 ")).toBe(
    true,
  );
  expect(isAllowedOrigin("http://localhost:5181", "http://localhost:5182")).toBe(false);
  expect(isAllowedOrigin("", "")).toBe(false);
  expect(isAllowedOrigin("", "http://a.test,")).toBe(false);
  expect(isAllowedOrigin("null", undefined)).toBe(false);
  expect(isAllowedOrigin(`${HOSTED_ORIGIN}.evil.test`, undefined)).toBe(false);
});

function upgrade(ip: string | null, headers: Record<string, string> = {}, path = RENDEZVOUS_PATH) {
  return new Request(`https://rendezvous.test${path}`, {
    headers: { Upgrade: "websocket", ...(ip ? { "CF-Connecting-IP": ip } : {}), ...headers },
  });
}

test("route sends each network to its own object", async () => {
  const a = await route(upgrade("198.51.100.1"), env());
  const b = await route(upgrade("198.51.100.2"), env());
  expect(a).toEqual({ network: (await networkKey("198.51.100.1", SECRET))! });
  expect(b).toEqual({ network: (await networkKey("198.51.100.2", SECRET))! });
  expect(a).not.toEqual(b);
  expect(await route(upgrade("2001:db8:1:2::a"), env())).toEqual(
    await route(upgrade("2001:db8:1:2:ffff::b"), env()),
  );
  // A dual-stack CLI's two sockets: different networks, so different objects.
  expect(await route(upgrade("2001:db8:1:2::a"), env())).not.toEqual(a);
});

test("route fails closed without NETWORK_KEY_SECRET", async () => {
  for (const secret of [undefined, ""]) {
    expect(await route(upgrade("198.51.100.1"), { NETWORK_KEY_SECRET: secret })).toMatchObject({
      status: 500,
      message: expect.stringContaining("NETWORK_KEY_SECRET"),
    });
  }
});

test("route checks the path, the upgrade, the Origin and the address", async () => {
  const ip = "198.51.100.1";
  expect(await route(upgrade(ip, {}, "/"), env())).toMatchObject({ status: 404 });
  expect(await route(upgrade(ip, {}, `${RENDEZVOUS_PATH}/x`), env())).toMatchObject({
    status: 404,
  });
  expect(await route(upgrade(ip, { Upgrade: "h2c" }), env())).toMatchObject({ status: 426 });
  expect(await route(upgrade(ip, { Origin: "https://evil.test" }), env())).toMatchObject({
    status: 403,
  });
  expect(await route(upgrade(ip, { Origin: HOSTED_ORIGIN }), env())).toHaveProperty("network");
  expect(
    await route(
      upgrade(ip, { Origin: "http://localhost:5181" }),
      env({ ALLOWED_ORIGINS: "http://localhost:5181" }),
    ),
  ).toHaveProperty("network");
  expect(await route(upgrade(null), env())).toMatchObject({ status: 400 });
});
