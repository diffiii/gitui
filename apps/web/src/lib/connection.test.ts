import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_HEADER, pairingFragment, REPO_NOT_OPENED } from "@gitui/shared";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getConfig, repoApi } from "./api.ts";
import {
  afterRejection,
  ApiError,
  apiTransport,
  connectionStatus,
  getConnection,
  initConnection,
  initialConnection,
  rejectConnection,
  retryWhileUnreachable,
  setNearbyHost,
  setPairing,
  subscribeConnection,
  type Connection,
  type ConnectionStatus,
} from "./connection.ts";
import type { NearbySession } from "./nearby/session.ts";
import type { NearbyHost } from "./nearby/state.ts";

const pairing = { port: 4778, token: "s3cret" };
const paired: Connection = { kind: "paired", pairing };

test("initialConnection is dev on the dev server and uses the saved pairing elsewhere", () => {
  const saved = pairingFragment(pairing);
  expect(initialConnection(true, saved)).toEqual({ kind: "dev" });
  expect(initialConnection(false, saved)).toEqual(paired);
  expect(initialConnection(false, "")).toEqual({ kind: "unpaired" });
  expect(initialConnection(false, "garbage")).toEqual({ kind: "unpaired" });
});

const host = { key: "k".repeat(16), name: "Jan's MacBook" };

/** A session that records what it is asked, and answers requests with what it was sent. */
function fakeSession(h: NearbyHost) {
  const session = {
    host: h,
    stopped: 0,
    woken: 0,
    getState: () => ({ kind: "connecting" }) as const,
    subscribe: () => () => {},
    fetch: async (path: string, init?: RequestInit) =>
      Response.json({ path, headers: Object.fromEntries(new Headers(init?.headers)) }),
    submitCode: async () => {},
    retry: () => {},
    wake: () => void session.woken++,
    stop: () => void session.stopped++,
  } satisfies NearbySession & Record<string, unknown>;
  return session;
}

const session = fakeSession(host);
const nearby: Connection = { kind: "nearby", session };

test("initialConnection returns the saved nearby host, without opening anything", () => {
  const savedHost = JSON.stringify(host);
  expect(initialConnection(false, "", savedHost)).toEqual({ kind: "nearby", host });
  expect(initialConnection(true, "", savedHost)).toEqual({ kind: "dev" });
  expect(initialConnection(false, pairingFragment(pairing), savedHost)).toEqual(paired);
  expect(initialConnection(false, "", "{bad json")).toEqual({ kind: "unpaired" });
  expect(initialConnection(false, "", '{"key":"short","name":"x"}')).toEqual({
    kind: "unpaired",
  });
});

test("apiTransport sends nearby requests through the session, with the client header", async () => {
  const res = await apiTransport(nearby)("/api/config", { headers: { "content-type": "x" } });
  expect(await res.json()).toEqual({
    path: "/api/config",
    headers: { [CLIENT_HEADER]: "1", "content-type": "x" },
  });
});

test("connectionStatus of a nearby connection is its session", () => {
  const config = { dataUpdatedAt: 1, errorUpdatedAt: 0, failureReason: null };
  expect(connectionStatus(nearby, config)).toEqual({ kind: "nearby", session });
});

describe("apiTransport over HTTP", () => {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  beforeAll(() =>
    stub("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
      return new Response();
    }),
  );
  afterAll(restoreGlobals);

  test("stays same-origin on the dev server", async () => {
    await apiTransport({ kind: "dev" })("/api/config", {});
    expect(sent.pop()).toEqual({ url: "/api/config", headers: { [CLIENT_HEADER]: "1" } });
  });

  test("sends paired requests to the CLI on loopback with the token", async () => {
    await apiTransport(paired)("/api/config", {});
    expect(sent.pop()).toEqual({
      url: "http://127.0.0.1:4778/api/config",
      headers: { [CLIENT_HEADER]: "1", authorization: "Bearer s3cret" },
    });
  });
});

test("apiTransport fails requests without an accepted pairing as unauthorized", () => {
  const connections = [{ kind: "unpaired" }, { kind: "rejected", pairing }];
  for (const connection of connections as Connection[]) {
    const fail = () => apiTransport(connection);
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

test("connectionStatus: dev is connected, the others need pairing", () => {
  const pending = { dataUpdatedAt: 0, errorUpdatedAt: 0, failureReason: null };
  const failed = { dataUpdatedAt: 0, errorUpdatedAt: 1, failureReason: new Error("boom") };
  for (const config of [pending, failed]) {
    expect(connectionStatus({ kind: "dev" }, config)).toEqual({ kind: "connected" });
    expect(connectionStatus({ kind: "unpaired" }, config)).toEqual({ kind: "unpaired" });
    expect(connectionStatus({ kind: "rejected", pairing }, config)).toEqual({ kind: "rejected" });
  }
});

test("afterRejection: only a pairing is rejected", () => {
  expect(afterRejection(paired)).toEqual({ kind: "rejected", pairing });
  for (const settled of [
    { kind: "dev" },
    { kind: "unpaired" },
    { kind: "rejected", pairing },
    nearby,
  ]) {
    expect(afterRejection(settled as Connection)).toBeNull();
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

// A hosted copy on a loopback host (e.g. `vp preview`): it pairs all the same.
describe("the connection store in the hosted app", () => {
  const url = new URL("http://localhost:4173/?repo=%2Fr&view=history#port=4778&token=s3cret");
  const storage = new Map<string, string>();
  const events: Record<string, (event?: unknown) => void> = {};
  const page = { visibilityState: "visible", listeners: {} as Record<string, () => void> };
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const open = (h: NearbyHost) => {
    const s = fakeSession(h);
    sessions.push(s);
    return s;
  };
  let respond: () => Promise<Response> = () => Promise.reject(new TypeError("Failed to fetch"));
  const queryClient = new QueryClient();

  beforeAll(() => {
    stub("location", url);
    stub("document", {
      addEventListener: (type: string, fn: () => void) => (page.listeners[type] = fn),
      get visibilityState() {
        return page.visibilityState;
      },
    });
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
    initConnection(queryClient, { open });
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

  test("a 404 says the CLI is too old for the page, and keeps the pairing", async () => {
    respond = () => Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    const error = await failure(getConfig());
    expect(error).toMatchObject({ kind: "http" });
    expect((error as Error).message).toContain("npx @diffiii/gitui@latest");
    expect(getConnection()).toEqual(paired);
  });

  test("a plain-text 404 is an ordinary error, not an outdated CLI", async () => {
    respond = () =>
      Promise.resolve(new Response("Not found", { status: 404, statusText: "Not Found" }));
    const error = await failure(getConfig());
    expect(error).toMatchObject({ kind: "http", message: "Not Found" });
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
    expect(getConnection()).toEqual({ kind: "nearby", session: sessions.at(-1)! });
    expect(sessions.at(-1)!.host).toEqual(host);
    expect(storage.has("gitui-pairing")).toBe(false);
    expect(JSON.parse(storage.get("gitui-nearby-host")!)).toEqual(host);
    expect(queryClient.getQueryData(["/r", "status"])).toBeUndefined();
  });

  test("picking the same host again keeps its session", () => {
    const before = getConnection();
    setNearbyHost({ ...host });
    expect(getConnection()).toBe(before);
    expect(sessions.at(-1)!.stopped).toBe(0);
  });

  test("showing the page again wakes the session", () => {
    page.visibilityState = "hidden";
    page.listeners.visibilitychange!();
    expect(sessions.at(-1)!.woken).toBe(0);
    page.visibilityState = "visible";
    page.listeners.visibilitychange!();
    events.pageshow!({ persisted: true });
    expect(sessions.at(-1)!.woken).toBe(2);
  });

  test("another host stops the session, which forgets its token, once the app moved on", () => {
    const first = sessions.at(-1)!;
    const stoppedWhenNotified: number[] = [];
    const unsubscribe = subscribeConnection(() => stoppedWhenNotified.push(first.stopped));
    setNearbyHost({ key: "n".repeat(16), name: host.name });
    unsubscribe();
    expect(stoppedWhenNotified).toEqual([0]);
    expect(first.stopped).toBe(1);
    expect(sessions.at(-1)!.stopped).toBe(0);
  });

  test("disconnecting stops the session and forgets the nearby host", () => {
    setNearbyHost(null);
    expect(sessions.at(-1)!.stopped).toBe(1);
    expect(getConnection()).toEqual({ kind: "unpaired" });
    expect(storage.has("gitui-nearby-host")).toBe(false);
  });

  test("a pairing link replaces the nearby host and stops its session", () => {
    setNearbyHost(host);
    setPairing(pairing);
    expect(sessions.at(-1)!.stopped).toBe(1);
    expect(getConnection()).toEqual(paired);
    expect(storage.has("gitui-nearby-host")).toBe(false);
    setPairing(null);
  });
});

// A page from the dev server: it calls its own `/api`, and adopts no pairing links.
describe("the connection store on the dev server", () => {
  const url = new URL("http://localhost:5173/?repo=%2Fr#port=4778&token=s3cret");
  const page = { listeners: {} as Record<string, () => void> };
  const sent: string[] = [];
  const queryClient = new QueryClient();

  beforeAll(() => {
    stub("location", url);
    stub("document", {
      addEventListener: (type: string, fn: () => void) => (page.listeners[type] = fn),
    });
    stub("localStorage", {
      getItem: (k: string) => (k === "gitui-pairing" ? pairingFragment(pairing) : null),
      setItem: () => {},
      removeItem: () => {},
    });
    stub("addEventListener", () => {
      throw new Error("the dev server's page listens to nothing");
    });
    const config = { initialRepo: null, recent: ["/r"], home: "/home/u" };
    stub("fetch", (path: string) => (sent.push(path), Promise.resolve(Response.json(config))));
    initConnection(queryClient, { dev: true });
  });
  afterAll(restoreGlobals);

  test("is dev whatever was saved, and leaves the address alone", () => {
    expect(getConnection()).toEqual({ kind: "dev" });
    expect(url.hash).toBe("#port=4778&token=s3cret");
    expect(page.listeners).toEqual({});
  });

  test("sends requests to its own /api", async () => {
    expect(await getConfig()).toMatchObject({ recent: ["/r"] });
    expect(sent).toEqual(["/api/config"]);
  });

  test("a 401 is just an error response", async () => {
    stub("fetch", status401);
    expect(await failure(getConfig())).toMatchObject({ kind: "unauthorized" });
    expect(getConnection()).toEqual({ kind: "dev" });
  });

  test("a 403 with the not-opened code is a not-opened error", async () => {
    stub("fetch", () =>
      Promise.resolve(Response.json({ error: "nope", code: REPO_NOT_OPENED }, { status: 403 })),
    );
    expect(await failure(repoApi("/r").status())).toMatchObject({
      kind: "not-opened",
      message: "nope",
    });
  });

  test("any other 403 is an http error", async () => {
    stub("fetch", () => Promise.resolve(Response.json({ error: "no" }, { status: 403 })));
    expect(await failure(repoApi("/r").status())).toMatchObject({ kind: "http", message: "no" });
  });

  test("a 500 with a body that isn't JSON is an http error with the status text", async () => {
    stub("fetch", () =>
      Promise.resolve(new Response("boom", { status: 500, statusText: "Internal Server Error" })),
    );
    expect(await failure(repoApi("/r").status())).toMatchObject({
      kind: "http",
      message: "Internal Server Error",
    });
  });

  test("an aborted request rejects with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("gone");
    controller.abort(reason);
    stub("fetch", () => Promise.reject(new DOMException("aborted", "AbortError")));
    expect(await failure(repoApi("/r").status({ signal: controller.signal }))).toBe(reason);
  });
});

// A reload of the hosted app connected to a nearby host: initConnection opens its session.
describe("the connection store in the hosted app with a saved nearby host", () => {
  const sessions: ReturnType<typeof fakeSession>[] = [];

  beforeAll(() => {
    stub("location", new URL("http://localhost:4173/"));
    stub("document", { addEventListener: () => {} });
    stub("history", { state: null, replaceState: () => {} });
    stub("localStorage", {
      getItem: (k: string) => (k === "gitui-nearby-host" ? JSON.stringify(host) : null),
      setItem: () => {},
      removeItem: () => {},
    });
    stub("addEventListener", () => {});
  });
  afterAll(restoreGlobals);

  test("opens one session with it, and only on initConnection", () => {
    expect(sessions).toHaveLength(0);
    initConnection(new QueryClient(), {
      open: (h) => {
        const s = fakeSession(h);
        sessions.push(s);
        return s;
      },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.host).toEqual(host);
    expect(getConnection()).toEqual({ kind: "nearby", session: sessions[0]! });
    setNearbyHost(null);
    expect(sessions[0]!.stopped).toBe(1);
  });
});
