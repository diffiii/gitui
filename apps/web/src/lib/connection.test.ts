import { expect, test } from "bun:test";
import { CLIENT_HEADER, pairingUrl } from "@gitui/shared";
import { apiTarget, isLoopbackHost, pairingFromLink } from "./connection.ts";

test("isLoopbackHost tells the local UI from the hosted one", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
  for (const h of ["gitui.diffiii.workers.dev", "192.168.1.20", "localhost.example.com", ""]) {
    expect(isLoopbackHost(h)).toBe(false);
  }
});

test("apiTarget stays same-origin without a pairing", () => {
  expect(apiTarget(null)).toEqual({ base: "", headers: { [CLIENT_HEADER]: "1" } });
});

test("apiTarget sends paired requests to the CLI on loopback with the token", () => {
  expect(apiTarget({ port: 4778, token: "s3cret" })).toEqual({
    base: "http://127.0.0.1:4778",
    headers: { [CLIENT_HEADER]: "1", authorization: "Bearer s3cret" },
  });
});

test("pairingFromLink reads the link gitui prints", () => {
  const link = pairingUrl("https://gitui.example", { port: 4777, token: "a+b/c=" });
  expect(pairingFromLink(link)).toEqual({ port: 4777, token: "a+b/c=" });
  expect(pairingFromLink("#port=4777&token=t")).toEqual({ port: 4777, token: "t" });
});

test("pairingFromLink rejects links without a pairing", () => {
  for (const link of ["", "https://gitui.example/", "port=4777&token=t", "https://x/#port=4777"]) {
    expect(pairingFromLink(link)).toBeNull();
  }
});
