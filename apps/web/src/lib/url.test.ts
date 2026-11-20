import { expect, test } from "bun:test";
import { closeSteps, createUrlStore, parseUrl, type UrlEnv, urlSearch } from "./url.ts";

test("parseUrl defaults the view and ignores unknown ones", () => {
  expect(parseUrl("")).toEqual({
    repo: null,
    view: "changes",
    all: false,
    file: null,
    staged: false,
    commit: null,
    branch: null,
  });
  expect(parseUrl("?view=nope").view).toBe("changes");
  expect(parseUrl("?view=branches").view).toBe("branches");
});

test("urlSearch round-trips through parseUrl and leaves out defaults", () => {
  const state = {
    repo: "/code/my repo",
    view: "branches" as const,
    all: false,
    file: null,
    staged: false,
    commit: "abc123",
    branch: "refs/heads/feat/x",
  };
  expect(parseUrl(urlSearch(state))).toEqual(state);
  expect(urlSearch(parseUrl(""))).toBe("");
  const file = parseUrl("?repo=%2Fr&file=src%2Fa.ts&staged=1");
  expect(file).toMatchObject({ repo: "/r", file: "src/a.ts", staged: true });
  expect(urlSearch(file)).toBe("?repo=%2Fr&file=src%2Fa.ts&staged=1");
  expect(urlSearch({ ...parseUrl(""), staged: true })).toBe("");
});

test("closeSteps goes back past the entry that opened the detail and any opened after it", () => {
  expect(closeSteps(["commit"], "commit")).toBe(1);
  expect(closeSteps(["branch", "commit"], "commit")).toBe(1);
  expect(closeSteps(["branch", "commit"], "branch")).toBe(2);
  expect(closeSteps([], "file")).toBeNull();
  expect(closeSteps(["commit"], "branch")).toBeNull();
});

/** A browser history stack. `go` fires popstate at once, where a browser does it later. */
function fakeBrowser(search = "") {
  const entries: { search: string; state: unknown }[] = [{ search, state: null }];
  let index = 0;
  const popListeners: (() => void)[] = [];
  const env: UrlEnv = {
    location: {
      pathname: "/",
      get search() {
        return entries[index].search;
      },
    },
    history: {
      get state() {
        return entries[index].state;
      },
      pushState(state, _, url) {
        entries.splice(index + 1, Infinity, { search: url.slice(1), state });
        index++;
      },
      replaceState(state, _, url) {
        entries[index] = { search: url.slice(1), state };
      },
      go(delta) {
        index = Math.max(0, Math.min(entries.length - 1, index + delta));
        popListeners.forEach((l) => l());
      },
    },
    addEventListener: (_, listener) => popListeners.push(listener),
  };
  const store = createUrlStore(env);
  return {
    store,
    url: () => store.getSnapshot(),
    at: () => ({ index, length: entries.length }),
    back: () => env.history.go(-1),
  };
}

test("opening a detail pushes an entry that its back control and system Back both close", () => {
  const b = fakeBrowser("?view=history");
  b.store.select({ commit: "a" }, "commit");
  expect(b.url().commit).toBe("a");
  expect(b.at()).toEqual({ index: 1, length: 2 });
  b.store.select({ commit: "parent" }); // switching what the detail shows replaces
  expect(b.at()).toEqual({ index: 1, length: 2 });
  b.store.closeDetail("commit");
  expect(b.url()).toMatchObject({ view: "history", commit: null });
  expect(b.at().index).toBe(0);

  b.store.select({ commit: "a" }, "commit");
  b.back();
  expect(b.url().commit).toBeNull();
});

test("a branch's commit closes on its own, and closing the branch closes both", () => {
  const b = fakeBrowser("?view=branches");
  b.store.select({ branch: "refs/heads/x", commit: null }, "branch");
  b.store.select({ commit: "c" }, "commit");
  expect(b.at()).toEqual({ index: 2, length: 3 });
  b.store.closeDetail("commit");
  expect(b.url()).toMatchObject({ branch: "refs/heads/x", commit: null });

  b.store.select({ commit: "c" }, "commit");
  b.store.closeDetail("branch");
  expect(b.url()).toMatchObject({ branch: null, commit: null });
  expect(b.at().index).toBe(0);
});

test("a detail opened by a link closes in place", () => {
  const b = fakeBrowser("?view=history&commit=a");
  b.store.closeDetail("commit");
  expect(b.url().commit).toBeNull();
  expect(b.at()).toEqual({ index: 0, length: 1 });
});

test("opening a detail from an entry that opened one of its kind reuses that entry", () => {
  const b = fakeBrowser();
  b.store.select({ file: "a.ts", staged: false }, "file");
  // a.ts was staged elsewhere, so the list shows again and another file opens from it
  b.store.select({ file: "b.ts", staged: false }, "file");
  expect(b.at()).toEqual({ index: 1, length: 2 });
  b.store.closeDetail("file");
  expect(b.url().file).toBeNull();
  expect(b.at().index).toBe(0);
});

test("switching views leaves Back doing the same, whether or not a detail was open", () => {
  const plain = fakeBrowser("?repo=%2Fr");
  plain.store.setView("/r", "history");
  expect(plain.url()).toMatchObject({ repo: "/r", view: "history" });
  expect(plain.at().index).toBe(0);

  const open = fakeBrowser("?repo=%2Fr");
  open.store.select({ file: "a.ts" }, "file");
  open.store.setView("/r", "history");
  expect(open.url()).toMatchObject({ repo: "/r", view: "history", file: null });
  expect(open.at().index).toBe(0);
});

test("the History view's all-branches flag is a replaced URL option that a view switch resets", () => {
  const b = fakeBrowser("?view=history&commit=a");
  b.store.select({ all: true, commit: null });
  expect(b.url()).toMatchObject({ all: true, commit: null });
  expect(b.at()).toEqual({ index: 0, length: 1 });
  b.store.setView(null, "branches");
  expect(b.url().all).toBe(false);
});

test("subscribers hear every change, including system Back", () => {
  const b = fakeBrowser();
  let calls = 0;
  b.store.subscribe(() => calls++);
  b.store.select({ file: "a.ts" }, "file");
  b.back();
  expect(calls).toBe(2);
});
