import { useMediaQuery } from "./media.ts";
import { closeDetail, type DetailParam, select, type UrlState } from "./url.ts";

/**
 * What a list/detail view shows in its detail: the chosen item; with none, side-by-side panes show
 * the first item, and stacked ones (narrow screens) show the list instead.
 */
export function shownItem<T>(chosen: T | null, first: T | null, stacked: boolean): T | null {
  return chosen ?? (stacked ? null : first);
}

/**
 * Whether choosing an item opens `param`'s detail over the list, as a history entry: only when the
 * panes are stacked and the list is showing.
 */
export function opensDetail(
  param: DetailParam,
  stacked: boolean,
  shown: unknown,
): DetailParam | undefined {
  return stacked && shown === null ? param : undefined;
}

export interface ListChoice<T> {
  /** Whether the panes are stacked (the media query matches). */
  stacked: boolean;
  /** The item the detail shows, or null for none (see `shownItem`). */
  shown: T | null;
  /** Shows the item `patch` puts in the URL. */
  choose: (patch: Partial<UrlState>) => void;
  /** Closes the detail. */
  close: () => void;
}

/**
 * A list/detail view's choice, kept in the URL as `param`: its panes stack while `breakpoint` (a
 * media query) matches. `chosen` is the URL's item as the list stands now, `first` the list's
 * first item.
 */
export function useListChoice<T>({
  param,
  breakpoint,
  chosen,
  first,
}: {
  param: DetailParam;
  breakpoint: string;
  chosen: T | null;
  first: T | null;
}): ListChoice<T> {
  const stacked = useMediaQuery(breakpoint);
  const shown = shownItem(chosen, first, stacked);
  return {
    stacked,
    shown,
    choose: (patch) => select(patch, opensDetail(param, stacked, shown)),
    close: () => closeDetail(param),
  };
}
