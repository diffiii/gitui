import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_HEADER, pairingFragment } from "@gitui/shared";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getConfig } from "./api.ts";
import {
  ApiError,
  apiTarget,
  connectionStatus,
  getConnection,
  initConnection,
  initialConnection,
  rejectPairing,
  retryWhileUnreachable,
  setPairing,
  type Connection,
  type ConnectionStatus,
} from "./connection.ts";

const pairing = { port: 4778, token: "s3cret" };
const paired: Connection = { kind: "paired", pairing };

test("initialConnection is local in a page gitui served and uses the saved pairing elsewhere", () => {
  const saved = pairingFragment(pairing);
  expect(initialConnection(true, saved)).toEqual({ kind: "local" });
  expect(initialConnection(false, saved)).toEqual(paired);
  expect(initialConnection(false, "")).toEqual({ kind: "unpaired" });
  expect(initialConnection(false, "garbage")).toEqual({ kind: "unpaired" });
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

test("apiTarget fails requests without an accepted pairing as unauthorized", () => {
  for (const connection of [{ kind: "unpaired" }, { kind: "rejected", pairing }] as const) {
    const fail = () => apiTarget(connection);
    expect(fail).toThrow(ApiError);
    expect(fail).toThrow(expect.objectContaining({ kind: "unauthorized" }));
  }
});

/** What `promise` rejects with (or resolves to). */
const failure = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

const unreachable = () => Promise.reject(new ApiError("Can't reach gitui", "unreachable"));
const http = () => Promise.reject(new ApiError("Internal Server Error", "http"));

/** Runs the gate's `["config"]` query against `queryFn` and records each status it implies. */
function observeGate(queryFn: () => Promise<unknown>) {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["config"],
    queryFn,
    ...retryWhileUnreachable,
    retryDelay: 1,
  });
  const seen: ConnectionStatus["kind"][] = [];
  const record = () => {
    const kind = connectionStatus(paired, observer.getCurrentResult()).kind;
    if (seen.at(-1) !== kind) seen.push(kind);
  };
  const unsubscribe = observer.subscribe(record);
  record();
  const until = async (done: () => boolean) => {
    while (!done()) await new Promise((r) => setTimeout(r, 1));
  };
  return {
    observer,
    seen,
    until,
    stop() {
      unsubscribe();
      client.clear();
    },
  };
}

test("connectionStatus: local is always connected, unpaired and rejected need pairing", () => {
  const settled = { dataUpdatedAt: 1, errorUpdatedAt: 0, failureReason: null };
  expect(connectionStatus({ kind: "local" }, settled)).toEqual({ kind: "connected" });
  expect(connectionStatus({ kind: "unpaired" }, settled)).toEqual({ kind: "unpaired" });
  expect(connectionStatus({ kind: "rejected", pairing }, settled)).toEqual({ kind: "rejected" });
});

test("the gate keeps retrying an unreachable CLI without going back to connecting", async () => {
  let calls = 0;
  let up = false;
  const gate = observeGate(() => (++calls, up ? Promise.resolve({ recent: [] }) : unreachable()));
  await gate.until(() => calls >= 3);
  void gate.observer.refetch(); // what a window focus does
  await gate.until(() => calls >= 5);
  expect(gate.seen).toEqual(["connecting", "unreachable"]);
  expect(connectionStatus(paired, gate.observer.getCurrentResult())).toEqual({
    kind: "unreachable",
    port: 4778,
  });
  up = true;
  await gate.until(() => gate.observer.getCurrentResult().isSuccess);
  expect(gate.seen).toEqual(["connecting", "unreachable", "connected"]);
  gate.stop();
});

test("the gate stays connected after an error response, across refetches", async () => {
  let calls = 0;
  const gate = observeGate(() => (++calls === 1 ? http() : unreachable()));
  await gate.until(() => gate.observer.getCurrentResult().isError);
  void gate.observer.refetch();
  await gate.until(() => calls >= 3);
  expect(gate.seen).toEqual(["connecting", "connected"]);
  gate.stop();
});

// A hosted copy on a loopback host (e.g. `vp preview`): without the marker it pairs all the same.
describe("the connection store in the hosted app", () => {
  const url = new URL("http://localhost:4173/?repo=%2Fr&view=history#port=4778&token=s3cret");
  const storage = new Map<string, string>();
  const events: Record<string, () => void> = {};
  let respond: () => Promise<Response> = () => Promise.reject(new TypeError("Failed to fetch"));
  const queryClient = new QueryClient();
  const saved: [string, PropertyDescriptor | undefined][] = [];
  const stub = (name: string, value: unknown) => {
    saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };

  beforeAll(() => {
    stub("location", url);
    stub("document", { querySelector: () => null }); // no LOCAL_UI_META tag
    stub("history", {
      state: null,
      replaceState: (_state: unknown, _title: string, to: string) =>
        (url.href = new URL(to, url).href),
    });
    stub("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    stub("addEventListener", (type: string, fn: () => void) => (events[type] = fn));
    stub("fetch", () => respond());
    initConnection(queryClient);
  });
  afterAll(() => {
    for (const [name, d] of saved.reverse()) {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  });

  const status401 = () =>
    Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 }));

  test("adopts the pairing link it was opened with and strips it from the address", () => {
    expect(getConnection()).toEqual(paired);
    expect(url.href).toBe("http://localhost:4173/?repo=%2Fr&view=history");
    expect(storage.get("gitui-pairing")).toBe(pairingFragment(pairing));
  });

  test("ignores an invalid hash but strips it", () => {
    url.hash = "#garbage";
    events.hashchange!();
    expect(getConnection()).toEqual(paired);
    expect(url.href).toBe("http://localhost:4173/?repo=%2Fr&view=history");
  });

  test("an unreachable CLI leaves the pairing alone", async () => {
    respond = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await failure(getConfig())).toMatchObject({ kind: "unreachable" });
    expect(getConnection()).toEqual(paired);
  });

  test("a 401 rejects the pairing and drops what was fetched over it", async () => {
    queryClient.setQueryData(["/r", "status"], {});
    respond = status401;
    expect(await failure(getConfig())).toMatchObject({ kind: "unauthorized" });
    expect(getConnection()).toEqual({ kind: "rejected", pairing });
    expect(queryClient.getQueryData(["/r", "status"])).toBeUndefined();
  });

  test("pairing again with the same link recovers from a rejection", () => {
    setPairing(pairing);
    expect(getConnection()).toEqual(paired);
  });

  test("a stale request's 401 doesn't reject a newer pairing", async () => {
    let answer: (res: Response) => void = () => {};
    respond = () => new Promise((r) => (answer = r));
    const stale = getConfig();
    url.hash = "#port=4779&token=new";
    events.hashchange!();
    const repaired = getConnection();
    expect(repaired).toEqual({ kind: "paired", pairing: { port: 4779, token: "new" } });
    answer(Response.json({ error: "Unauthorized" }, { status: 401 }));
    expect(await failure(stale)).toMatchObject({ kind: "unauthorized" });
    expect(getConnection()).toBe(repaired);
    rejectPairing(paired);
    expect(getConnection()).toBe(repaired);
  });

  test("disconnecting forgets the saved pairing", () => {
    setPairing(null);
    expect(getConnection()).toEqual({ kind: "unpaired" });
    expect(storage.has("gitui-pairing")).toBe(false);
  });
});
