import { expect, test } from "bun:test";
import { HOSTED_ORIGIN, RENDEZVOUS_PATH } from "@gitui/shared";
import { isAllowedOrigin, networkKey, networkOf, route } from "./route.ts";

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

test("networkKey hashes the network", async () => {
  const key = await networkKey("203.0.113.7");
  expect(key).toMatch(/^[\da-f]{64}$/);
  expect(await networkKey("::ffff:203.0.113.7")).toBe(key);
  expect(await networkKey("203.0.113.8")).not.toBe(key);
  expect(await networkKey("2001:db8::1")).toBe(await networkKey("2001:db8::ffff:2"));
  expect(await networkKey("2001:db8::1")).not.toBe(await networkKey("2001:db8:0:1::1"));
  expect(await networkKey("nope")).toBeNull();
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
  const a = await route(upgrade("198.51.100.1"), undefined);
  const b = await route(upgrade("198.51.100.2"), undefined);
  expect(a).toEqual({ network: (await networkKey("198.51.100.1"))! });
  expect(b).toEqual({ network: (await networkKey("198.51.100.2"))! });
  expect(a).not.toEqual(b);
  expect(await route(upgrade("2001:db8:1:2::a"), undefined)).toEqual(
    await route(upgrade("2001:db8:1:2:ffff::b"), undefined),
  );
});

test("route checks the path, the upgrade, the Origin and the address", async () => {
  const ip = "198.51.100.1";
  expect(await route(upgrade(ip, {}, "/"), undefined)).toMatchObject({ status: 404 });
  expect(await route(upgrade(ip, {}, `${RENDEZVOUS_PATH}/x`), undefined)).toMatchObject({
    status: 404,
  });
  expect(await route(upgrade(ip, { Upgrade: "h2c" }), undefined)).toMatchObject({ status: 426 });
  expect(await route(upgrade(ip, { Origin: "https://evil.test" }), undefined)).toMatchObject({
    status: 403,
  });
  expect(await route(upgrade(ip, { Origin: HOSTED_ORIGIN }), undefined)).toHaveProperty("network");
  expect(
    await route(upgrade(ip, { Origin: "http://localhost:5181" }), "http://localhost:5181"),
  ).toHaveProperty("network");
  expect(await route(upgrade(null), undefined)).toMatchObject({ status: 400 });
});
