import { useSyncExternalStore } from "react";
import { isView, VIEWS, type View } from "./views.ts";

/**
 * What the URL holds: the repo, the view, the view's options and what it shows in its detail
 * pane. The URL is the source of truth for all of it; components read it as an external store.
 */
export interface UrlState {
  repo: string | null;
  view: View;
  /** History: every branch's commits rather than the current branch's. */
  all: boolean;
  /** Changes: the file shown, and whether it's its staged entry. */
  file: string | null;
  staged: boolean;
  /** History, and Branches' history: the commit shown. */
  commit: string | null;
  /** Branches: the full refname of the branch shown. */
  branch: string | null;
}

/** A detail that opens over its list on a stacked (narrow) layout, named by its URL parameter. */
export type DetailParam = "file" | "commit" | "branch";

/** What closing each detail clears; a branch's commit goes with it. */
const CLEARS: Record<DetailParam, Partial<UrlState>> = {
  file: { file: null, staged: false },
  commit: { commit: null },
  branch: { branch: null, commit: null },
};

export function parseUrl(search: string): UrlState {
  const sp = new URLSearchParams(search);
  const view = sp.get("view");
  return {
    repo: sp.get("repo"),
    view: isView(view) ? view : VIEWS[0].view,
    all: sp.get("all") === "1",
    file: sp.get("file"),
    staged: sp.get("staged") === "1",
    commit: sp.get("commit"),
    branch: sp.get("branch"),
  };
}

/** The query string for `state`, leaving out defaults; empty, or starting with `?`. */
export function urlSearch(state: UrlState): string {
  const sp = new URLSearchParams();
  if (state.repo) sp.set("repo", state.repo);
  if (state.view !== VIEWS[0].view) sp.set("view", state.view);
  if (state.all) sp.set("all", "1");
  if (state.file) {
    sp.set("file", state.file);
    if (state.staged) sp.set("staged", "1");
  }
  if (state.branch) sp.set("branch", state.branch);
  if (state.commit) sp.set("commit", state.commit);
  return sp.size ? `?${sp}` : "";
}

/**
 * How many history entries to go back to close `param`'s detail, given the details opened (in
 * order) by the entries pushed up to this one. Null when its entry isn't there, as after opening
 * a link straight to the detail.
 */
export function closeSteps(opened: readonly DetailParam[], param: DetailParam): number | null {
  const i = opened.lastIndexOf(param);
  return i < 0 ? null : opened.length - i;
}

/** The state of a history entry: the details opened by the entries pushed up to it, oldest first. */
interface EntryState {
  opened: DetailParam[];
}

/** The parts of `window` the store uses, so tests can hand it a fake. */
export interface UrlEnv {
  location: { pathname: string; search: string };
  history: {
    readonly state: unknown;
    pushState(state: EntryState | null, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
    go(delta: number): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
}

/**
 * The URL store over `env`. Views share one history entry; only details opened over their list
 * add entries, which Back (the browser's, or a detail's back control) goes back past.
 */
export function createUrlStore(env: UrlEnv) {
  const { location, history } = env;
  let cache: { search: string; state: UrlState } | undefined;
  const listeners = new Set<() => void>();
  /** Runs once the browser has gone back, which it does asynchronously. */
  let afterPop: (() => void) | undefined;

  const getSnapshot = () => {
    const { search } = location;
    if (cache?.search !== search) cache = { search, state: parseUrl(search) };
    return cache.state;
  };
  const notify = () => listeners.forEach((l) => l());
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  env.addEventListener("popstate", () => {
    const run = afterPop;
    afterPop = undefined;
    run?.();
    notify();
  });

  const opened = () => (history.state as EntryState | null)?.opened ?? [];
  const write = (next: UrlState, entry: "push" | "replace", state: EntryState | null) => {
    const url = location.pathname + urlSearch(next);
    if (entry === "push") history.pushState(state, "", url);
    else history.replaceState(state, "", url);
    notify();
  };
  const select = (patch: Partial<UrlState>, opens?: DetailParam) => {
    const next = { ...getSnapshot(), ...patch };
    const stack = opened();
    // An entry pushed to open this same detail, which went away (a file staged elsewhere, a
    // deleted branch), is reused: pushing on top would leave a Back that changes nothing.
    if (opens && stack.at(-1) !== opens) write(next, "push", { opened: [...stack, opens] });
    else write(next, "replace", history.state as EntryState | null);
  };

  return {
    subscribe,
    getSnapshot,

    /** Opens another repository, as a new history entry. */
    openRepo(repo: string) {
      write({ ...parseUrl(""), repo }, "push", null);
    },

    /**
     * Switches to `view`, dropping what the previous one showed. With details open, it first goes
     * back past their entries, so that Back after switching views always does the same thing,
     * whatever was open: it leaves the view's one entry.
     */
    setView(repo: string | null, view: View) {
      const switchTo = () => write({ ...parseUrl(""), repo, view }, "replace", null);
      const steps = opened().length;
      if (!steps) return switchTo();
      afterPop = switchTo;
      history.go(-steps);
    },

    /**
     * Shows `patch`. With `opens`, it opens that detail over its list (a stacked layout) as a new
     * history entry, so Back closes it; otherwise it replaces the entry, as selecting in a list
     * next to its detail does.
     */
    select,

    /** Closes `param`'s detail: back past the entry that opened it or, without one, clearing it. */
    closeDetail(param: DetailParam) {
      const steps = closeSteps(opened(), param);
      if (steps) history.go(-steps);
      else select(CLEARS[param]);
    },
  };
}

// The app's store, over the real window once something uses it, so importing this is safe anywhere.
let store: ReturnType<typeof createUrlStore> | undefined;
const url = () => (store ??= createUrlStore(window));

export const useUrl = () => useSyncExternalStore(url().subscribe, url().getSnapshot);
export const openRepo = (repo: string) => url().openRepo(repo);
export const setView = (repo: string | null, view: View) => url().setView(repo, view);
export const select = (patch: Partial<UrlState>, opens?: DetailParam) => url().select(patch, opens);
export const closeDetail = (param: DetailParam) => url().closeDetail(param);
