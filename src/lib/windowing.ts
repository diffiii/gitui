/**
 * Half-open range `[start, end)` of fixed-height rows to render for a scrolled viewport,
 * padded by `overscan` rows on each side and clamped to `[0, count]`.
 */
export function visibleRange(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportH)) / rowH);
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, Math.max(start, last + overscan));
  return { start, end };
}
