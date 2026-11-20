import { describe, expect, test } from "bun:test";
import { parseRefs } from "./RefBadges.tsx";

describe("parseRefs", () => {
  test("HEAD pointing at a branch", () => {
    expect(parseRefs(["HEAD -> refs/heads/feat/x"])).toEqual([{ kind: "head", name: "feat/x" }]);
  });

  test("detached HEAD", () => {
    expect(parseRefs(["HEAD"])).toEqual([{ kind: "detached", name: "HEAD" }]);
  });

  test("tags", () => {
    expect(parseRefs(["tag: refs/tags/v1"])).toEqual([{ kind: "tag", name: "v1" }]);
  });

  test("local branches", () => {
    expect(parseRefs(["refs/heads/main"])).toEqual([{ kind: "branch", name: "main" }]);
  });

  test("remote branches, dropping the remote HEAD", () => {
    expect(
      parseRefs(["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/up/a/b"]),
    ).toEqual([
      { kind: "remote", name: "origin/main" },
      { kind: "remote", name: "up/a/b" },
    ]);
  });

  test("stash is dropped", () => {
    expect(parseRefs(["refs/stash"])).toEqual([]);
  });

  test("full decoration keeps order", () => {
    expect(
      parseRefs([
        "HEAD -> refs/heads/main",
        "tag: refs/tags/v1.0",
        "refs/remotes/origin/main",
        "refs/heads/other",
      ]),
    ).toEqual([
      { kind: "head", name: "main" },
      { kind: "tag", name: "v1.0" },
      { kind: "remote", name: "origin/main" },
      { kind: "branch", name: "other" },
    ]);
  });
});
