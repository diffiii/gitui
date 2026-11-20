// What `gitui --nearby` says about its listing on the rendezvous service, decided without I/O:
// one line once every IP family connected or failed (or STATUS_DELAY passed), then a line when
// the last family drops and when one is back. A missing family stays quiet. host.ts feeds it the
// clients' events and prints the lines.
import type { Family } from "./rendezvous.ts";

/**
 * Where the host stands: `starting` until the first line, then `up` while some family is
 * welcomed, `unreachable` if none was by the first line, and `lost` once every family dropped
 * after the host was visible.
 */
export type Phase = "starting" | "up" | "unreachable" | "lost";

export interface Status {
  readonly phase: Phase;
  /** The families the service welcomed, until they drop. */
  readonly visible: readonly Family[];
  /** The families that haven't connected or failed yet; the first line waits for them. */
  readonly unsettled: readonly Family[];
  /** The service's lack of room last said since the last welcome, if any. */
  readonly noRoomSaid: NoRoom | null;
}

/**
 * Why the service had no room for this host: the network lists as many hosts as it may
 * (`hosts`), or this host's key has as many sockets there as it may (`sockets`): earlier ones of
 * this run's, since only this run holds the secret behind its key.
 */
export type NoRoom = "hosts" | "sockets";

export type StatusEvent =
  | { type: "welcome"; family: Family }
  | { type: "down"; family: Family }
  /** STATUS_DELAY passed. */
  | { type: "timeout" }
  /** The service had no room for this host (MAX_HOSTS or MAX_SOCKETS_PER_KEY). */
  | { type: "no-room"; why: NoRoom };

/** A line to print: host.ts words them. */
export type StatusLine =
  | "visible"
  | "unreachable"
  | "lost"
  | "reconnected"
  | "no-room-hosts"
  | "no-room-sockets";

/** The status of a host that registers over `families`. */
export const initialStatus = (families: readonly Family[]): Status => ({
  phase: "starting",
  visible: [],
  unsettled: families,
  noRoomSaid: null,
});

type Next = [Status, StatusLine | null];

/** The first line, said once every family settled or STATUS_DELAY passed. */
const announce = (status: Status): Next =>
  status.visible.length
    ? [{ ...status, phase: "up" }, "visible"]
    : [{ ...status, phase: "unreachable" }, "unreachable"];

/** The status after `event`, and the line it calls for, if any (at most one). */
export function nextStatus(status: Status, event: StatusEvent): Next {
  if (event.type === "no-room") {
    if (status.noRoomSaid === event.why) return [status, null];
    return [{ ...status, noRoomSaid: event.why }, `no-room-${event.why}`];
  }
  if (event.type === "timeout")
    return status.phase === "starting" ? announce(status) : [status, null];

  const { family } = event;
  const welcomed = event.type === "welcome";
  const next: Status = {
    ...status,
    visible: welcomed
      ? [...status.visible.filter((f) => f !== family), family]
      : status.visible.filter((f) => f !== family),
    unsettled: status.unsettled.filter((f) => f !== family),
    noRoomSaid: welcomed ? null : status.noRoomSaid,
  };
  switch (status.phase) {
    case "starting":
      return next.unsettled.length ? [next, null] : announce(next);
    case "up":
      return next.visible.length ? [next, null] : [{ ...next, phase: "lost" }, "lost"];
    case "unreachable":
    case "lost":
      if (!welcomed) return [next, null];
      return [{ ...next, phase: "up" }, status.phase === "lost" ? "reconnected" : "visible"];
  }
}
