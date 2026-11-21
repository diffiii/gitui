// The nearby connection's errors that the code loaded up front needs too (lazy.ts).

/** A failure worth showing as is. */
export class NearbyError extends Error {
  override name = "NearbyError";
}

/** What a page that is out of date says (PageOutdatedError). */
export const PAGE_OUTDATED = "This page is out of date. Reload it.";

/**
 * This page can't load code it loads on demand (the nearby code, or CPace): it was deployed over
 * since the page loaded, so the chunk is gone. Only a reload helps.
 */
export class PageOutdatedError extends NearbyError {
  override name = "PageOutdatedError";
  constructor() {
    super(PAGE_OUTDATED);
  }
}
