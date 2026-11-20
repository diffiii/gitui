import { LANE_COLORS, type GraphRow } from "@/lib/graph";

export const ROW_H = 30;
/** Row height under a finger, tall enough to tap. */
export const TOUCH_ROW_H = 40;
const LANE_W = 14;
const R = 4;

const x = (lane: number) => LANE_W / 2 + lane * LANE_W + 4;
const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

function curve(x1: number, y1: number, x2: number, y2: number) {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

export function graphWidth(lanes: number) {
  return lanes * LANE_W + 8;
}

/** Draws one row of the commit graph, `height` px tall; rows tile vertically. */
export function GraphCell({
  row,
  hash,
  width,
  height,
}: {
  row: GraphRow;
  hash: string;
  width: number;
  height: number;
}) {
  const mid = height / 2;
  const cx = x(row.col);
  return (
    <svg width={graphWidth(width)} height={height} className="shrink-0 overflow-visible">
      {row.before.map((l, j) => {
        if (!l) return null;
        if (l.hash === hash) {
          return (
            <path
              key={`in${j}`}
              d={curve(x(j), 0, cx, mid)}
              stroke={color(l.color)}
              strokeWidth={2}
              fill="none"
            />
          );
        }
        return (
          <path
            key={`p${j}`}
            d={`M${x(j)} 0V${height}`}
            stroke={color(l.color)}
            strokeWidth={2}
            fill="none"
          />
        );
      })}
      {row.edges.map((e, i) => (
        <path
          key={`e${i}`}
          d={curve(cx, mid, x(e.to), height)}
          stroke={color(e.color)}
          strokeWidth={2}
          fill="none"
        />
      ))}
      {row.merge ? (
        <circle
          cx={cx}
          cy={mid}
          r={R}
          fill="var(--background)"
          stroke={color(row.color)}
          strokeWidth={2}
        />
      ) : (
        <circle
          cx={cx}
          cy={mid}
          r={R}
          fill={color(row.color)}
          stroke="var(--background)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
