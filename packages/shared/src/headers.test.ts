import { expect, test } from "bun:test";
import { hostedHeadersFile } from "./headers.ts";

test("the hosted app's _headers file secures every path and lets it reach the CLI and the rendezvous", () => {
  expect(hostedHeadersFile()).toBe(`/*
  Content-Security-Policy: script-src 'self'; connect-src 'self' http://127.0.0.1:* wss://rendezvous.gitui.diffiii.dev; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`);
});

test("a build for another rendezvous lets the page reach that one instead", () => {
  expect(hostedHeadersFile("ws://127.0.0.1:5187")).toContain(
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:5187;",
  );
  for (const bad of ["https://x.example", "wss://x.example/v1", "wss://a.example; script-src *"]) {
    expect(() => hostedHeadersFile(bad)).toThrow(/ws: or wss: origin/);
  }
});
