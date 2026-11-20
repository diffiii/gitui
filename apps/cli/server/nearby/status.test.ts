import { expect, test } from "bun:test";
import type { Family } from "./rendezvous.ts";
import { initialStatus, nextStatus, type StatusEvent, type StatusLine } from "./status.ts";

/** The lines a run of events calls for. */
function run(families: Family[], events: StatusEvent[]) {
  let status = initialStatus(families);
  const lines: StatusLine[] = [];
  for (const event of events) {
    const [next, line] = nextStatus(status, event);
    status = next;
    if (line) lines.push(line);
  }
  return { status, lines };
}

const welcome = (family: Family): StatusEvent => ({ type: "welcome", family });
const down = (family: Family): StatusEvent => ({ type: "down", family });

test("one line once every family settled, or once the delay passed", () => {
  expect(run([4, 6], [welcome(4)]).lines).toEqual([]);
  expect(run([4, 6], [welcome(4), down(6)]).lines).toEqual(["visible"]);
  expect(run([4, 6], [welcome(6), { type: "timeout" }, welcome(4)]).lines).toEqual(["visible"]);
  expect(run([4, 6], [{ type: "timeout" }]).lines).toEqual(["unreachable"]);
});

test("losing the last family is said once, and so is coming back", () => {
  const { lines } = run(
    [4, 6],
    [welcome(4), welcome(6), down(4), down(6), down(4), down(6), welcome(6), welcome(4)],
  );
  expect(lines).toEqual(["visible", "lost", "reconnected"]);
});

test("a host never visible says it is visible once it is", () => {
  const { lines, status } = run([4], [down(4), down(4), welcome(4)]);
  expect(lines).toEqual(["unreachable", "visible"]);
  expect(status.phase).toBe("up");
});

test("no room is said once until a welcome, or until the reason changes", () => {
  const hosts: StatusEvent = { type: "no-room", why: "hosts" };
  const sockets: StatusEvent = { type: "no-room", why: "sockets" };
  expect(run([4], [hosts, hosts, welcome(4), hosts, sockets, sockets]).lines).toEqual([
    "no-room-hosts",
    "visible",
    "no-room-hosts",
    "no-room-sockets",
  ]);
});
