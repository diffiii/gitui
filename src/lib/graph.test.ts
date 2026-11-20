import { describe, expect, test } from "bun:test";
import type { Commit } from "./api.ts";
import { layoutGraph } from "./graph.ts";

const c = (hash: string, parents: string[] = []): Commit => ({
  hash,
  parents,
  author: "",
  email: "",
  date: 0,
  refs: [],
  subject: hash,
});

describe("layoutGraph", () => {
  test("empty history", () => {
    expect(layoutGraph([])).toEqual({ rows: [], width: 1 });
  });

  test("linear history stays in lane 0", () => {
    const { rows, width } = layoutGraph([c("c3", ["c2"]), c("c2", ["c1"]), c("c1")]);
    expect(width).toBe(1);
    expect(rows).toEqual([
      { col: 0, color: 0, before: [], edges: [{ to: 0, color: 0 }], merge: false },
      {
        col: 0,
        color: 0,
        before: [{ hash: "c2", color: 0 }],
        edges: [{ to: 0, color: 0 }],
        merge: false,
      },
      { col: 0, color: 0, before: [{ hash: "c1", color: 0 }], edges: [], merge: false },
    ]);
  });

  test("branch then merge", () => {
    // m merges b into a; both fork from x.
    const { rows, width } = layoutGraph([c("m", ["a", "b"]), c("a", ["x"]), c("b", ["x"]), c("x")]);
    expect(width).toBe(2);

    const [m, a, b, x] = rows;
    expect(m.merge).toBe(true);
    expect(m.col).toBe(0);
    // First parent continues the lane, second parent opens a new one with a new color.
    expect(m.edges).toEqual([
      { to: 0, color: 0 },
      { to: 1, color: 1 },
    ]);

    expect(a.merge).toBe(false);
    expect(a.col).toBe(0);
    expect(a.before).toEqual([
      { hash: "a", color: 0 },
      { hash: "b", color: 1 },
    ]);
    expect(a.edges).toEqual([{ to: 0, color: 0 }]);

    // b sits in lane 1 and joins the lane already waiting for x.
    expect(b.col).toBe(1);
    expect(b.color).toBe(1);
    expect(b.edges).toEqual([{ to: 0, color: 0 }]);

    expect(x.col).toBe(0);
    expect(x.before).toEqual([{ hash: "x", color: 0 }]);
    expect(x.edges).toEqual([]);
  });

  test("freed lanes are reused", () => {
    const { rows, width } = layoutGraph([
      c("m", ["a", "b"]), // lanes: a b
      c("k", ["z"]), // new tip in lane 2: a b z
      c("b", ["a"]), // lane 1 freed: a _ z
      c("d", ["a"]), // new tip reuses lane 1
      c("a", ["z"]),
      c("z"),
    ]);
    expect(width).toBe(3);
    expect(rows.map((r) => r.col)).toEqual([0, 2, 1, 1, 0, 2]);

    const d = rows[3];
    expect(d.before[1]).toBeNull();
    expect(d.color).toBe(3);
    expect(d.edges).toEqual([{ to: 0, color: 0 }]);

    // a's parent is already tracked in lane 2.
    expect(rows[4].edges).toEqual([{ to: 2, color: 2 }]);
  });

  test("width counts the widest row", () => {
    const { width } = layoutGraph([c("m", ["a", "b", "e"]), c("a"), c("b"), c("e")]);
    expect(width).toBe(3);
  });
});
