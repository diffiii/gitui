import { expect, test } from "bun:test";
import { CLIENT_HEADER, pairingFragment } from "@gitui/shared";
import {
  ApiError,
  apiTarget,
  connectionStatus,
  initialConnection,
  isLoopbackHost,
  type Connection,
} from "./connection.ts";

const pairing = { port: 4778, token: "s3cret" };
const paired: Connection = { kind: "paired", pairing };

test("isLoopbackHost tells the local UI from the hosted one", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
  for (const h of ["gitui.diffiii.workers.dev", "192.168.1.20", "localhost.example.com", ""]) {
    expect(isLoopbackHost(h)).toBe(false);
  }
});

test("initialConnection is local on loopback and uses the saved pairing elsewhere", () => {
  const saved = pairingFragment(pairing);
  expect(initialConnection("localhost", saved)).toEqual({ kind: "local" });
  expect(initialConnection("gitui.example", saved)).toEqual(paired);
  expect(initialConnection("gitui.example", "")).toEqual({ kind: "unpaired" });
  expect(initialConnection("gitui.example", "garbage")).toEqual({ kind: "unpaired" });
});

test("apiTarget stays same-origin for the local UI", () => {
  expect(apiTarget({ kind: "local" })).toEqual({ base: "", headers: { [CLIENT_HEADER]: "1" } });
});

test("apiTarget sends paired requests to the CLI on loopback with the token", () => {
  expect(apiTarget(paired)).toEqual({
    base: "http://127.0.0.1:4778",
    headers: { [CLIENT_HEADER]: "1", authorization: "Bearer s3cret" },
  });
});

test("apiTarget fails an unpaired request as unauthorized", () => {
  const fail = () => apiTarget({ kind: "unpaired" });
  expect(fail).toThrow(ApiError);
  expect(fail).toThrow(expect.objectContaining({ kind: "unauthorized" }));
});

const loading = { data: undefined, error: null };
const config = { recent: [] };
const unreachable = new ApiError("Can't reach gitui", "unreachable");
const unauthorized = new ApiError("Unauthorized", "unauthorized");
const http = new ApiError("Internal Server Error", "http");

test("connectionStatus: local is always connected, unpaired always needs pairing", () => {
  for (const q of [loading, { data: undefined, error: unreachable }]) {
    expect(connectionStatus({ kind: "local" }, q)).toEqual({ kind: "connected" });
    expect(connectionStatus({ kind: "unpaired" }, q)).toEqual({ kind: "unpaired" });
  }
});

test("connectionStatus: a paired app connects once gitui answers", () => {
  expect(connectionStatus(paired, loading)).toEqual({ kind: "connecting" });
  expect(connectionStatus(paired, { data: undefined, error: unreachable })).toEqual({
    kind: "unreachable",
    port: 4778,
  });
  expect(connectionStatus(paired, { data: config, error: null })).toEqual({ kind: "connected" });
  // gitui answered, just with an error: the app shows it.
  expect(connectionStatus(paired, { data: undefined, error: http })).toEqual({ kind: "connected" });
});

test("connectionStatus: a connected app stays up when gitui stops answering", () => {
  for (const error of [unreachable, http, new Error("other")]) {
    expect(connectionStatus(paired, { data: config, error })).toEqual({ kind: "connected" });
  }
});

test("connectionStatus: a rejected token always goes back to pairing", () => {
  for (const data of [undefined, config]) {
    expect(connectionStatus(paired, { data, error: unauthorized })).toEqual({ kind: "rejected" });
  }
});
