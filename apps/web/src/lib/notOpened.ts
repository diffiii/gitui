import { isApiError } from "./connection.ts";

/**
 * Whether the repo isn't opened on the computer (this device may only use those), from its status
 * query and the last verdict (`kept`). A query without data drops its error while it fetches
 * again, so the verdict stands until the next one: the screen saying so doesn't flash away on
 * every poll, or for as long as a nearby session reconnects.
 */
export function notOpened(kept: boolean, status: { data: unknown; error: unknown }): boolean {
  if (status.error) return isApiError(status.error, "not-opened");
  return kept && status.data === undefined;
}
