import { expect, test } from "bun:test";
import { closeSteps, parseUrl, urlSearch } from "./url.ts";

test("parseUrl defaults the view and ignores unknown ones", () => {
  expect(parseUrl("")).toEqual({
    repo: null,
    view: "changes",
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
});

test("urlSearch drops `staged` without a file", () => {
  expect(urlSearch({ ...parseUrl(""), staged: true })).toBe("");
});

test("closeSteps goes back past the entry that opened the detail and any opened after it", () => {
  expect(closeSteps(["commit"], "commit")).toBe(1);
  expect(closeSteps(["branch", "commit"], "commit")).toBe(1);
  expect(closeSteps(["branch", "commit"], "branch")).toBe(2);
  expect(closeSteps(["file", "commit", "commit"], "commit")).toBe(1);
});

test("closeSteps is null for a detail opened by a link rather than an entry", () => {
  expect(closeSteps([], "file")).toBeNull();
  expect(closeSteps(["commit"], "branch")).toBeNull();
});
