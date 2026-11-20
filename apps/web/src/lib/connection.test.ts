import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_HEADER, pairingFragment } from "@gitui/shared";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getConfig } from "./api.ts";
import {
  afterRejection,
  ApiError,
  apiTarget,
  connectionStatus,
  getConnection,
  initConnection,
  initialConnection,
  rejectConnection,
  retrySession,
  retryWhileUnreachable,
  setNearbyHost,
  setPairing,
  type Connection,
  type ConnectionStatus,
} from "./connection.ts";
import type { NearbyState } from "./nearby/state.ts";
import { tokens } from "./nearby/tokens.ts";

const pairing = { port: 4778, token: "s3cret" };
const paired: Connection = { kind: "paired", pairing };

test("initialConnection is local in a page gitui served and uses the saved pairing elsewhere", () => {
  const saved = pairingFragment(pairing);
  expect(initialConnection(true, saved)).toEqual({ kind: "local" });
  expect(initialConnection(false, saved)).toEqual(paired);
  expect(initialConnection(false, "")).toEqual({ kind: "unpaired" });
  expect(initialConnection(false, "garbage")).toEqual({ kind: "unpaired" });
});

const host = { key: "k".repeat(16), name: "Jan's MacBook" };
const nearby: Connection = { kind: "nearby", host };

test("initialConnection falls back to the saved nearby host", () => {
  const savedHost = JSON.stringify(host);
  expect(initialConnection(false, "", savedHost)).toEqual(nearby);
  expect(initialConnection(true, "", savedHost)).toEqual({ kind: "local" });
  expect(initialConnection(false, pairingFragment(pairing), savedHost)).toEqual(paired);
  expect(initialConnection(false, "", "{bad json")).toEqual({ kind: "unpaired" });
  expect(initialConnection(false, "", '{"key":"short","name":"x"}')).toEqual({ kind: "unpaired" });
});

test("apiTarget sends nearby requests as paths, with the client header", () => {
  expect(apiTarget(nearby)).toEqual({ base: "", headers: { [CLIENT_HEADER]: "1" } });
});

test("connectionStatus of a nearby connection follows its session", () => {
  const config = { dataUpdatedAt: 0, errorUpdatedAt: 0, failureReason: null };
  const status = (session: NearbyState) => connectionStatus(nearby, config, session);
  const name = host.name;
  expect(status({ kind: "off" })).toEqual({ kind: "nearbyConnecting", host: name });
  expect(status({ kind: "connecting", host })).toEqual({ kind: "nearbyConnecting", host: name });
  expect(status({ kind: "code", host, checking: false })).toEqual({
    kind: "nearbyCode",
    host: name,
    checking: false,
  });
  expect(
    status({ kind: "code", host, checking: true, attemptsLeft: 2, notice: "expired" }),
  ).toEqual({ kind: "nearbyCode", host: name, checking: true, attemptsLeft: 2, notice: "expired" });
  expect(status({ kind: "connected", host })).toEqual({ kind: "connected" });
  expect(status({ kind: "reconnecting", host })).toEqual({ kind: "reconnecting", host: name });
  expect(status({ kind: "failed", host, reason: "gone" })).toEqual({
    kind: "nearbyFailed",
    host: name,
    reason: "gone",
  });
  // A session for another host is one the store hasn't caught up with yet.
  const other = { key: "o".repeat(16), name: "Desktop" };
  expect(status({ kind: "connected", host: other })).toEqual({
    kind: "nearbyConnecting",
    host: name,
  });
  // Without a session it is connecting, whatever the config query did.
  expect(connectionStatus(nearby, { ...config, dataUpdatedAt: 1 })).toEqual({
    kind: "nearbyConnecting",
    host: name,
  });
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

test("apiTarget fails requests without an accepted pairing or session as unauthorized", () => {
  const connections = [{ kind: "unpaired" }, { kind: "rejected", pairing }, { kind: "noSession" }];
  for (const connection of connections as Connection[]) {
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

test("connectionStatus: local is connected, the others need pairing", () => {
  const pending = { dataUpdatedAt: 0, errorUpdatedAt: 0, failureReason: null };
  const failed = { dataUpdatedAt: 0, errorUpdatedAt: 1, failureReason: new Error("boom") };
  for (const config of [pending, failed]) {
    expect(connectionStatus({ kind: "local" }, config)).toEqual({ kind: "connected" });
    expect(connectionStatus({ kind: "noSession" }, config)).toEqual({ kind: "noSession" });
    expect(connectionStatus({ kind: "unpaired" }, config)).toEqual({ kind: "unpaired" });
    expect(connectionStatus({ kind: "rejected", pairing }, config)).toEqual({ kind: "rejected" });
  }
});

test("afterRejection: a local page loses its session, a pairing is rejected", () => {
  // Only `gitui --lan` turns a local page away; other local pages never get a 401.
  expect(afterRejection({ kind: "local" })).toEqual({ kind: "noSession" });
  expect(afterRejection(paired)).toEqual({ kind: "rejected", pairing });
  for (const settled of [
    { kind: "noSession" },
    { kind: "unpaired" },
    { kind: "rejected", pairing },
    nearby,
  ]) {
    const connection = settled as Connection;
    expect(afterRejection(connection)).toBe(connection);
  }
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

const saved: [string, PropertyDescriptor | undefined][] = [];

/** Replaces the global `name` until `restoreGlobals`. */
function stub(name: string, value: unknown) {
  saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobals() {
  for (const [name, d] of saved.reverse()) {
    if (d) Object.defineProperty(globalThis, name, d);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  saved.length = 0;
}

const status401 = () => Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 }));

// A hosted copy on a loopback host (e.g. `vp preview`): without the marker it pairs all the same.
describe("the connection store in the hosted app", () => {
  const url = new URL("http://localhost:4173/?repo=%2Fr&view=history#port=4778&token=s3cret");
  const storage = new Map<string, string>();
  const events: Record<string, () => void> = {};
  let respond: () => Promise<Response> = () => Promise.reject(new TypeError("Failed to fetch"));
  const queryClient = new QueryClient();

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
  afterAll(restoreGlobals);

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
    rejectConnection(paired);
    expect(getConnection()).toBe(repaired);
  });

  test("disconnecting forgets the saved pairing", () => {
    setPairing(null);
    expect(getConnection()).toEqual({ kind: "unpaired" });
    expect(storage.has("gitui-pairing")).toBe(false);
  });

  test("picking a nearby host saves it in place of a pairing, and drops the cache", () => {
    setPairing(pairing);
    queryClient.setQueryData(["/r", "status"], {});
    setNearbyHost(host);
    expect(getConnection()).toEqual(nearby);
    expect(storage.has("gitui-pairing")).toBe(false);
    expect(JSON.parse(storage.get("gitui-nearby-host")!)).toEqual(host);
    expect(queryClient.getQueryData(["/r", "status"])).toBeUndefined();
  });

  test("the host's restarted run replaces it and its dead token", () => {
    tokens.save(host.key, "old");
    const next = { key: "n".repeat(16), name: host.name };
    setNearbyHost(next);
    expect(tokens.load(host.key)).toBeNull();
    setNearbyHost(host);
  });

  test("picking the same host again keeps its token", () => {
    tokens.save(host.key, "tok");
    setNearbyHost(host);
    expect(tokens.load(host.key)).toBe("tok");
  });

  test("disconnecting forgets the nearby host and its token", () => {
    tokens.save(host.key, "tok");
    setNearbyHost(null);
    expect(getConnection()).toEqual({ kind: "unpaired" });
    expect(storage.has("gitui-nearby-host")).toBe(false);
    expect(tokens.load(host.key)).toBeNull();
  });

  test("a pairing link replaces the nearby host and forgets its token", () => {
    setNearbyHost(host);
    tokens.save(host.key, "tok");
    setPairing(pairing);
    expect(getConnection()).toEqual(paired);
    expect(storage.has("gitui-nearby-host")).toBe(false);
    expect(tokens.load(host.key)).toBeNull();
    setPairing(null);
  });
});

// A page `gitui --lan` serves: it has the marker, and its requests need the session cookie.
describe("the connection store in a page gitui served", () => {
  const queryClient = new QueryClient();
  const page = { visibilityState: "visible", listeners: {} as Record<string, () => void> };
  let calls = 0;
  let respond: () => Promise<Response> = status401;

  beforeAll(() => {
    stub("location", new URL("http://192.168.1.5:4777/"));
    stub("document", {
      querySelector: () => ({}), // the LOCAL_UI_META tag
      addEventListener: (type: string, fn: () => void) => (page.listeners[type] = fn),
      get visibilityState() {
        return page.visibilityState;
      },
    });
    stub("fetch", () => (++calls, respond()));
    initConnection(queryClient);
  });
  afterAll(restoreGlobals);

  /**
   * Mounts what the gate renders once connected, the app's `["config"]` query, until it has data
   * or the session is lost (which drops the query, and the gate unmounts the app).
   */
  async function mountApp() {
    const observer = new QueryObserver(queryClient, { queryKey: ["config"], queryFn: getConfig });
    const stop = observer.subscribe(() => {});
    while (!observer.getCurrentResult().isSuccess && getConnection().kind === "local") {
      await new Promise((r) => setTimeout(r, 1));
    }
    stop();
    return observer.getCurrentResult();
  }

  const show = (state: "visible" | "hidden") => {
    page.visibilityState = state;
    page.listeners.visibilitychange!();
  };

  test("starts local", () => {
    expect(getConnection()).toEqual({ kind: "local" });
  });

  test("a 401 loses the session and drops what was fetched", async () => {
    queryClient.setQueryData(["/r", "status"], {});
    await mountApp();
    expect(getConnection()).toEqual({ kind: "noSession" });
    expect(queryClient.getQueryData(["/r", "status"])).toBeUndefined();
  });

  test("being hidden doesn't retry, being shown again does", () => {
    show("hidden");
    expect(getConnection()).toEqual({ kind: "noSession" });
    show("visible");
    expect(getConnection()).toEqual({ kind: "local" });
  });

  test("a retry without a session lands back in noSession, once", async () => {
    calls = 0;
    await mountApp();
    expect(calls).toBe(1);
    expect(getConnection()).toEqual({ kind: "noSession" });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
  });

  test("trying again once paired elsewhere brings the app back, refetching its config", async () => {
    const config = { initialRepo: null, recent: ["/r"], home: "/home/u" };
    respond = () => Promise.resolve(Response.json(config));
    retrySession();
    expect(getConnection()).toEqual({ kind: "local" });
    expect((await mountApp()).data).toEqual(config);
  });

  test("retrying is a no-op unless the session was lost", () => {
    const before = getConnection();
    retrySession();
    show("visible");
    expect(getConnection()).toBe(before);
  });
});
