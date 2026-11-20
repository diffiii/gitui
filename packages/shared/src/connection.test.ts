import { expect, test } from "bun:test";
import { pairingUrl, parsePairing } from "./connection.ts";

test("parsePairing reads what pairingUrl writes", () => {
  const url = new URL(pairingUrl("https://gitui.example", { port: 4778, token: "a+b/c=" }));
  expect(url.origin).toBe("https://gitui.example");
  expect(url.search).toBe("");
  expect(parsePairing(url.hash)).toEqual({ port: 4778, token: "a+b/c=" });
});

test("parsePairing rejects fragments without a valid port and token", () => {
  for (const hash of ["", "#", "#port=4777", "#token=t", "#port=0&token=t", "#port=x&token=t"]) {
    expect(parsePairing(hash)).toBeNull();
  }
});
