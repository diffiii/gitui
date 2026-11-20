import { useLayoutEffect, useState } from "react";

/** Rows mounted on each side of the viewport, so fast scrolling doesn't flash blank space. */
const OVERSCAN = 10;

/** Where a scroll viewport sits over a list, in rows: the first row under its top edge, and how many rows it can span. */
type View = { first: number; span: number };

/**
 * Half-open range `[start, end)` of rows to mount for `view`,
 * padded by `overscan` rows on each side and clamped to `[0, count]`.
 */
export function visibleRange(
  { first, span }: View,
  count: number,
  overscan: number,
): { start: number; end: number } {
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, Math.max(start, first + span + overscan));
  return { start, end };
}

/**
 * Windows a list of `count` rows, each `rowH` px tall, inside the scroll viewport handed to `viewportRef`.
 * Mount only rows `[start, end)`, with `before` and `after` px of spacer around them to keep the scroll height.
 */
export function useWindowedRows(count: number, rowH: number) {
  const [viewport, viewportRef] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<View>({ first: 0, span: 1 });
  useLayoutEffect(() => {
    if (!viewport) return;
    const update = () => {
      const first = Math.floor(Math.max(0, viewport.scrollTop) / rowH);
      // +1: a viewport scrolled off a row boundary straddles one row more than its height holds.
      const span = Math.ceil(viewport.clientHeight / rowH) + 1;
      setView((v) => (v.first === first && v.span === span ? v : { first, span }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    viewport.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", update);
    };
  }, [viewport, rowH]);
  const { start, end } = visibleRange(view, count, OVERSCAN);
  return { viewportRef, start, end, before: start * rowH, after: (count - end) * rowH };
}
