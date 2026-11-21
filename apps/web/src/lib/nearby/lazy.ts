import { NearbyError, PageOutdatedError } from "./errors.ts";
import type { NearbySession } from "./session.ts";
import type { NearbyHost, NearbyState } from "./state.ts";

// The nearby code (client.ts) reads the protocol with the codec, which brings Effect: too much
// for a page paired with gitui on this computer, which never uses it. So it loads on demand, when
// the connect screen lists the computers nearby or the app connects to one, and this is what the
// rest of the app holds until then. Nothing loaded up front may import the codec, or anything
// that does (vite.config.ts fails the build if the main chunk has Effect in it).

/** The nearby code. */
export type Nearby = typeof import("./client.ts");

let loading: Promise<Nearby | null> | undefined;
let loaded: Nearby | null = null;

/**
 * The nearby code, loading it on the first call; the same promise on every call. Null if it
 * can't load: this page was deployed over since it loaded, so the chunk is gone
 * (PageOutdatedError), and only a reload helps.
 */
export function loadNearby(): Promise<Nearby | null> {
  loading ??= import("./client.ts").then(
    (nearby) => (loaded = nearby),
    (e: unknown) => {
      console.error(e);
      return null;
    },
  );
  return loading;
}

/** The nearby code if it has loaded, else null. */
export const loadedNearby = (): Nearby | null => loaded;

const OUTDATED: NearbyState = {
  kind: "failed",
  reason: new PageOutdatedError().message,
  retryOnWake: false,
  reload: true,
};

/**
 * A session with `host` that loads its code first: `connecting` meanwhile (as a session starts
 * anyway), then the session that `load`'s function opens, or failed for a reload if it can't
 * load (null). Stopped before then, it opens none.
 */
export function lazySession(
  host: NearbyHost,
  load: () => Promise<((host: NearbyHost) => NearbySession) | null>,
): NearbySession {
  let state: NearbyState = { kind: "connecting" };
  let session: NearbySession | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const ready = load().then((open) => {
    if (state.kind === "off") return null;
    if (!open) {
      state = OUTDATED;
      notify();
      return null;
    }
    session = open(host);
    session.subscribe(notify);
    notify();
    return session;
  });

  return {
    host,
    getState: () => session?.getState() ?? state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    fetch: async (path, init) => {
      const opened = await ready;
      if (opened) return opened.fetch(path, init);
      throw state.kind === "off" ? new NearbyError("Disconnected.") : new PageOutdatedError();
    },
    submitCode: async (code) => {
      await (await ready)?.submitCode(code);
    },
    retry: () => session?.retry(),
    wake: () => session?.wake(),
    stop: () => {
      if (state.kind === "off") return;
      state = { kind: "off" };
      if (session) session.stop();
      else notify();
      listeners.clear();
    },
  };
}

/** A session with `host` over the page's nearby code, loaded on demand (nearbySession). */
export const openNearbySession = (host: NearbyHost): NearbySession =>
  lazySession(host, async () => (await loadNearby())?.nearbySession ?? null);
