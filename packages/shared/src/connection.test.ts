import { expect, test } from "bun:test";
import { pairingFragment, pairingUrl, parsePairing } from "./connection.ts";

const pairing = { port: 4778, token: "a+b/c=" };

test("pairingUrl puts the pairing in the fragment of the origin's root", () => {
  const url = new URL(pairingUrl("https://gitui.example", pairing));
  expect(url.origin).toBe("https://gitui.example");
  expect(url.pathname).toBe("/");
  expect(url.search).toBe("");
  expect(url.hash).toBe(pairingFragment(pairing));
});

test("parsePairing reads the fragment, a whole link and a saved fragment", () => {
  const link = pairingUrl("https://gitui.example", pairing);
  expect(parsePairing(new URL(link).hash)).toEqual(pairing);
  expect(parsePairing(link)).toEqual(pairing);
  expect(parsePairing(`  ${link}`)).toEqual(pairing);
  expect(parsePairing(pairingFragment(pairing))).toEqual(pairing);
  expect(parsePairing("https://x/?port=1&token=q#port=4777&token=t")).toEqual({
    port: 4777,
    token: "t",
  });
});

test("parsePairing rejects strings without a valid port and token after #", () => {
  for (const link of [
    "",
    "#",
    "port=4777&token=t",
    "https://gitui.example/",
    "#port=4777",
    "#token=t",
    "#port=0&token=t",
    "#port=x&token=t",
    "https://x/#port=4777",
  ]) {
    expect(parsePairing(link)).toBeNull();
  }
});
