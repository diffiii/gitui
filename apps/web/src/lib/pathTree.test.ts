import { expect, test } from "bun:test";
import { dirsOf, treeChanges } from "./pathTree.ts";

test("dirsOf lists every folder above the paths once", () => {
  expect(dirsOf(["a/b/c.ts", "a/d.ts", "e.ts"]).sort()).toEqual(["a/", "a/b/"]);
});

test("treeChanges adds and removes only what changed", () => {
  expect(treeChanges(["a/x.ts", "b.ts"], ["a/x.ts", "a/y.ts", "c.ts"])).toEqual([
    { type: "remove", path: "b.ts" },
    { type: "add", path: "a/y.ts" },
    { type: "add", path: "c.ts" },
  ]);
  expect(treeChanges(["a.ts"], ["a.ts"])).toEqual([]);
});

test("treeChanges removes a folder left empty, once, with what's in it", () => {
  expect(treeChanges(["a/b/c.ts", "a/b/d.ts", "a/e.ts", "f.ts"], ["f.ts"])).toEqual([
    { type: "remove", path: "a/", recursive: true },
  ]);
  expect(treeChanges(["a/b/c.ts", "a/e.ts"], ["a/e.ts"])).toEqual([
    { type: "remove", path: "a/b/", recursive: true },
  ]);
});

test("treeChanges turns a file into a folder of the same name and back", () => {
  expect(treeChanges(["a"], ["a/b"])).toEqual([
    { type: "remove", path: "a" },
    { type: "add", path: "a/b" },
  ]);
  expect(treeChanges(["a/b"], ["a"])).toEqual([
    { type: "remove", path: "a/", recursive: true },
    { type: "add", path: "a" },
  ]);
});
