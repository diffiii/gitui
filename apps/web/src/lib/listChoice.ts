import { useMediaQuery } from "./media.ts";

/**
 * What a list/detail view shows in its detail: the chosen item; with none, side-by-side panes show
 * the first item, and stacked ones (narrow screens) show the list instead.
 */
export function shownItem<T>(chosen: T | null, first: T | null, stacked: boolean): T | null {
  return chosen ?? (stacked ? null : first);
}

/** `shownItem` for a view whose panes stack while `breakpoint` (a media query) matches. */
export function useListChoice<T>(breakpoint: string, chosen: T | null, first: T | null) {
  const stacked = useMediaQuery(breakpoint);
  return { stacked, shown: shownItem(chosen, first, stacked) };
}
