import { describe, expect, test } from "bun:test";
import { parseConventionalCommit } from "./CommitTitle.tsx";

describe("parseConventionalCommit", () => {
  test("known types", () => {
    const feat = parseConventionalCommit("feat: add x");
    expect(feat).toMatchObject({ label: "Feature", color: "#a2eeef", rest: "add x" });
    expect(feat?.scope).toBeUndefined();
    expect(parseConventionalCommit("fix: y")?.label).toBe("Fix");
    expect(parseConventionalCommit("perf: y")?.label).toBe("Performance");
    expect(parseConventionalCommit("ci: y")?.label).toBe("CI");
    expect(parseConventionalCommit("FEAT: upper case")?.label).toBe("Feature");
  });

  test("scope", () => {
    const cc = parseConventionalCommit("fix(server): handle spaces");
    expect(cc?.scope).toBe("server");
    expect(cc?.rest).toBe("handle spaces");
  });

  test("breaking change marker", () => {
    expect(parseConventionalCommit("refactor!: drop api")?.label).toBe("Refactor!");
    const cc = parseConventionalCommit("feat(api)!: new shape");
    expect(cc?.label).toBe("Feature!");
    expect(cc?.scope).toBe("api");
    expect(cc?.rest).toBe("new shape");
  });

  test("unknown type or plain subject returns null", () => {
    expect(parseConventionalCommit("wip: stuff")).toBeNull();
    expect(parseConventionalCommit("Merge branch 'x'")).toBeNull();
    expect(parseConventionalCommit("initial commit")).toBeNull();
  });

  test("bare type with no description returns null", () => {
    expect(parseConventionalCommit("ci:")).toBeNull();
    expect(parseConventionalCommit("ci:   ")).toBeNull();
  });
});
