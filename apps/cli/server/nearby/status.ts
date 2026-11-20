// What `gitui --nearby` says about its listing on the rendezvous service, decided without I/O:
// one line once every IP family connected or failed (or STATUS_DELAY passed), then a line when
// the last family drops and when one is back. A missing family stays quiet. host.ts feeds it the
// clients' events and prints the lines.
import type { Family } from "./rendezvous.ts";

export interface Status {
  /** The families the host registers over. */
  readonly families: readonly Family[];
  /** Those the service welcomed, until they drop. */
  readonly visible: readonly Family[];
  /** Those that connected or failed at least once. */
  readonly settled: readonly Family[];
  /** Whether the first line was said. */
  readonly announced: boolean;
  /** Whether the host is said to be unreachable or lost, and not back yet. */
  readonly lost: boolean;
  readonly everVisible: boolean;
  /** Whether the service's lack of room was said since the last welcome. */
  readonly noRoomSaid: boolean;
}

export type StatusEvent =
  | { type: "welcome"; family: Family }
  | { type: "down"; family: Family }
  /** STATUS_DELAY passed. */
  | { type: "timeout" }
  /** The service had no room for this host (MAX_HOSTS or MAX_SOCKETS_PER_KEY). */
  | { type: "no-room" };

/** A line to print: host.ts words them. */
export type StatusLine = "visible" | "unreachable" | "lost" | "reconnected" | "no-room";

export const initialStatus = (families: readonly Family[]): Status => ({
  families,
  visible: [],
  settled: [],
  announced: false,
  lost: false,
  everVisible: false,
  noRoomSaid: false,
});

type Next = [Status, StatusLine | null];

const add = (list: readonly Family[], family: Family) =>
  list.includes(family) ? list : [...list, family];

function announce(status: Status): Next {
  if (status.announced) return [status, null];
  if (status.visible.length) return [{ ...status, announced: true }, "visible"];
  return [{ ...status, announced: true, lost: true }, "unreachable"];
}

function settle(status: Status, family: Family): Next {
  const next = { ...status, settled: add(status.settled, family) };
  return next.settled.length === next.families.length ? announce(next) : [next, null];
}

/** The status after `event`, and the line it calls for, if any (at most one). */
export function nextStatus(status: Status, event: StatusEvent): Next {
  switch (event.type) {
    case "timeout":
      return announce(status);
    case "no-room":
      return status.noRoomSaid ? [status, null] : [{ ...status, noRoomSaid: true }, "no-room"];
    case "welcome": {
      const visible = add(status.visible, event.family);
      const [next, line] = settle({ ...status, visible }, event.family);
      const back = next.announced && next.lost;
      const after = { ...next, lost: false, everVisible: true, noRoomSaid: false };
      if (back) return [after, next.everVisible ? "reconnected" : "visible"];
      return [after, line];
    }
    case "down": {
      const was = status.visible.includes(event.family);
      const visible = status.visible.filter((f) => f !== event.family);
      const [next, line] = settle({ ...status, visible }, event.family);
      if (next.announced && was && !visible.length && !next.lost) {
        return [{ ...next, lost: true }, "lost"];
      }
      return [next, line];
    }
  }
}
