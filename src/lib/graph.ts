import type { Commit } from "./api.ts";

type Lane = { hash: string; color: number } | null;

export interface GraphRow {
  /** Lane index of this commit's node. */
  col: number;
  color: number;
  /** Lanes entering the row from the top. */
  before: Lane[];
  /** Edges leaving the node towards the bottom of the row. */
  edges: { to: number; color: number }[];
  merge: boolean;
}

export const LANE_COLORS = [
  "oklch(0.70 0.15 250)",
  "oklch(0.72 0.16 150)",
  "oklch(0.75 0.15 70)",
  "oklch(0.68 0.19 20)",
  "oklch(0.68 0.17 300)",
  "oklch(0.74 0.12 200)",
  "oklch(0.72 0.17 110)",
  "oklch(0.70 0.16 340)",
];

function freeSlot(lanes: Lane[], from = 0) {
  for (let i = from; i < lanes.length; i++) if (!lanes[i]) return i;
  return lanes.length;
}

/**
 * Assigns each commit (in topological order, newest first) to a lane and computes the
 * edges connecting it to its parents. Lanes never move sideways, so each row can be drawn
 * independently and lines line up across rows.
 */
export function layoutGraph(commits: Commit[]): { rows: GraphRow[]; width: number } {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let width = 1;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const before = lanes.slice();
    let col = lanes.findIndex((l) => l?.hash === c.hash);
    let color: number;
    if (col === -1) {
      col = freeSlot(lanes);
      color = nextColor++;
    } else {
      color = lanes[col]!.color;
    }
    // All lanes waiting for this commit converge into its node.
    lanes = lanes.map((l) => (l?.hash === c.hash ? null : l));

    const edges: GraphRow["edges"] = [];
    c.parents.forEach((p, i) => {
      const existing = lanes.findIndex((l) => l?.hash === p);
      if (existing !== -1) {
        edges.push({ to: existing, color: lanes[existing]!.color });
      } else if (i === 0) {
        lanes[col] = { hash: p, color };
        edges.push({ to: col, color });
      } else {
        const k = freeSlot(lanes, col + 1);
        const clr = nextColor++;
        lanes[k] = { hash: p, color: clr };
        edges.push({ to: k, color: clr });
      }
    });
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();

    width = Math.max(width, before.length, lanes.length, col + 1);
    rows.push({ col, color, before, edges, merge: c.parents.length > 1 });
  }
  return { rows, width };
}
