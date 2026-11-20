import { expect, test } from "bun:test";
import { hostedHeadersFile, uiSecurityHeaders } from "./headers.ts";

test("the UI's headers let pages connect where they're told to", () => {
  expect(uiSecurityHeaders("'self'")).toEqual({
    "Content-Security-Policy":
      "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
});

test("the hosted app's _headers file applies them to every path and lets it reach the CLI", () => {
  expect(hostedHeadersFile()).toBe(`/*
  Content-Security-Policy: script-src 'self'; connect-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
`);
});
