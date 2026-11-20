import { useSyncExternalStore } from "react";
import { isView, VIEWS, type View } from "./views.ts";

/**
 * What the URL holds: the repo, the view, and what the view shows in its detail pane. The URL is
 * the source of truth for all of it; components read it as an external store.
 */
export interface UrlState {
  repo: string | null;
  view: View;
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
export function closeSteps(opened: readonly string[], param: DetailParam): number | null {
  const i = opened.lastIndexOf(param);
  return i < 0 ? null : opened.length - i;
}

// History entries that open a detail carry the details opened so far, oldest first.
interface EntryState {
  opened: string[];
}
const openedDetails = (): string[] => (history.state as EntryState | null)?.opened ?? [];

let state: UrlState | undefined;
const listeners = new Set<() => void>();
const sync = () => {
  state = parseUrl(location.search);
  listeners.forEach((l) => l());
};
// Reads the URL on first use, so importing this module is safe anywhere.
const read = () => (state ??= parseUrl(location.search));
const subscribe = (cb: () => void) => {
  if (!listeners.size) {
    addEventListener("popstate", sync);
    state = undefined; // the URL may have changed while nothing listened
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (!listeners.size) removeEventListener("popstate", sync);
  };
};

export const useUrl = () => useSyncExternalStore(subscribe, read);

function write(next: UrlState, how: "push" | "replace", entry: EntryState | null) {
  const url = location.pathname + urlSearch(next);
  if (how === "push") history.pushState(entry, "", url);
  else history.replaceState(entry, "", url);
  sync();
}

/** Opens another repository, as a new history entry. */
export function openRepo(repo: string) {
  write({ ...parseUrl(""), repo }, "push", null);
}

/** Switches to `view`, dropping what the previous view had open. */
export function setView(repo: string | null, view: View) {
  write({ ...parseUrl(""), repo, view }, "replace", null);
}

/**
 * Shows `patch`. With `opens`, it opens that detail over its list (a stacked layout), as a new
 * history entry, so Back closes it; otherwise it replaces the entry, as selecting in a list next
 * to its detail does.
 */
export function select(patch: Partial<UrlState>, opens?: DetailParam) {
  const next = { ...read(), ...patch };
  if (opens) write(next, "push", { opened: [...openedDetails(), opens] });
  else write(next, "replace", history.state as EntryState | null);
}

/** Closes `param`'s detail: back past the entry that opened it or, without one, clearing it. */
export function closeDetail(param: DetailParam) {
  const steps = closeSteps(openedDetails(), param);
  if (steps) history.go(-steps);
  else select(CLEARS[param]);
}
