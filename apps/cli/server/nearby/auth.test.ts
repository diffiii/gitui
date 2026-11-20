// The host's pure auth decisions: the pairing budget and a guest's Gatekeeper.
import { expect, test } from "bun:test";
import { AUTH_ATTEMPTS } from "@gitui/shared";
import { Gatekeeper, lockoutLine, PAIRING_BUDGET, PAIRING_WINDOW, PairingBudget } from "./auth.ts";
import { RollingWindow } from "./rolling.ts";

/** A budget on a clock the test moves; `lockouts` holds when each lockout said it ends. */
function clocked(limit = PAIRING_BUDGET) {
  let now = 1_000_000;
  const lockouts: number[] = [];
  const budget = new PairingBudget({ limit, now: () => now, onLockout: (u) => lockouts.push(u) });
  return { budget, lockouts, tick: (ms: number) => (now += ms), now: () => now };
}

/** A gatekeeper whose runs are strings. */
const gatekeeper = (budget = new PairingBudget()) => new Gatekeeper<string>(budget);
const run = () => "run";
const ANSWER = { kind: "answer", run: "run" } as const;

test("a rolling window takes `limit` in any `window`, and its getters change nothing", () => {
  let now = 0;
  const window = new RollingWindow(2, 100, () => now);
  expect(window.left).toBe(2);
  expect(window.freesAt).toBe(0);
  expect(window.take()).toBe(true);
  now = 50;
  expect(window.take()).toBe(true);
  expect(window.take()).toBe(false);
  expect([window.left, window.left]).toEqual([0, 0]);
  expect(window.freesAt).toBe(100);
  now = 100;
  expect(window.left).toBe(1);
  expect(window.take()).toBe(true);
  expect(window.freesAt).toBe(150);
  now = 250;
  expect(window.left).toBe(2);
});

test("the budget rolls over its window and says once per lockout until when", () => {
  const clock = clocked(3);
  const { budget, lockouts } = clock;
  const start = clock.now();
  expect(budget.spend()).toBe(true);
  clock.tick(PAIRING_WINDOW / 2);
  expect(budget.spend()).toBe(true);
  expect(lockouts).toEqual([]);
  expect(budget.spend()).toBe(true);
  // Locked until the first attempt leaves the window.
  expect(lockouts).toEqual([start + PAIRING_WINDOW]);
  expect(budget.exhausted).toBe(true);
  expect(budget.spend()).toBe(false);
  // A sustained attack takes each attempt that frees up: the same lockout, said once.
  clock.tick(PAIRING_WINDOW / 2);
  expect(budget.left).toBe(1);
  expect(budget.spend()).toBe(true);
  expect(lockouts).toHaveLength(1);
  // A whole window without attempts ends it; the next one is said again.
  clock.tick(PAIRING_WINDOW);
  expect(budget.left).toBe(3);
  for (let i = 0; i < 3; i++) budget.spend();
  expect(lockouts).toEqual([start + PAIRING_WINDOW, clock.now() + PAIRING_WINDOW]);
});

test("the lockout line says until when, why, and that paired devices still connect", () => {
  const until = new Date(2026, 10, 20, 9, 5).getTime();
  expect(lockoutLine(until)).toBe(
    "Nearby: too many pairing attempts in the last 10 minutes, so someone may be guessing " +
      "codes. New devices can't pair until 09:05 at the earliest; paired devices can still reconnect",
  );
});

test(`a wrong code fails ${AUTH_ATTEMPTS} times, then every try is refused`, () => {
  const gate = gatekeeper();
  for (let left = AUTH_ATTEMPTS - 1; left > 0; left--) {
    expect(gate.pake(run)).toEqual(ANSWER);
    expect(gate.confirm(() => false)).toEqual({ kind: "fail", attemptsLeft: left });
  }
  expect(gate.pake(run)).toEqual(ANSWER);
  expect(gate.confirm(() => false)).toEqual({ kind: "refuse", why: "attempts" });
  expect(gate.pake(run)).toEqual({ kind: "refuse", why: "attempts" });
  expect(gate.resume(true)).toEqual({ kind: "refuse", why: "attempts" });
});

test("the right code opens; a new pake gives up on the run before it", () => {
  const gate = gatekeeper();
  expect(gate.pake(() => "first")).toEqual({ kind: "answer", run: "first" });
  expect(gate.pake(() => "second")).toEqual({ kind: "answer", run: "second" });
  expect(gate.attemptsLeft).toBe(AUTH_ATTEMPTS - 2);
  const checked: string[] = [];
  expect(gate.confirm((r) => checked.push(r) > 0)).toEqual({ kind: "open" });
  expect(checked).toEqual(["second"]);
});

test("a share the host can't use is a failed attempt, with no run to confirm", () => {
  const gate = gatekeeper();
  expect(gate.pake(() => null)).toEqual({ kind: "fail", attemptsLeft: AUTH_ATTEMPTS - 1 });
  expect(gate.confirm(() => true)).toEqual({ kind: "violation" });
});

test("a pake that isn't answered never makes its run", () => {
  const { budget } = clocked(1);
  budget.spend();
  let made = 0;
  expect(gatekeeper(budget).pake(() => String(++made))).toEqual({ kind: "refuse", why: "budget" });
  expect(made).toBe(0);
});

test("a confirmation without a run breaks the protocol", () => {
  const gate = gatekeeper();
  expect(gate.confirm(() => true)).toEqual({ kind: "violation" });
  gate.pake(run);
  gate.confirm(() => false);
  expect(gate.confirm(() => true)).toEqual({ kind: "violation" });
  // A resume gives up on the run, too.
  gate.pake(run);
  gate.resume(false);
  expect(gate.confirm(() => true)).toEqual({ kind: "violation" });
});

test("a first resume is free if it fails; later ones spend attempts", () => {
  const gate = gatekeeper();
  expect(gate.resume(false)).toEqual({ kind: "fail", attemptsLeft: AUTH_ATTEMPTS });
  expect(gate.resume(false)).toEqual({ kind: "fail", attemptsLeft: AUTH_ATTEMPTS - 1 });
  expect(gate.resume(true)).toEqual({ kind: "open" });

  expect(gatekeeper().resume(true)).toEqual({ kind: "open" });
});

test("the budget is shared: once it is out, no pake is answered, and resumes still work", () => {
  const { budget } = clocked(2);
  const a = gatekeeper(budget);
  const b = gatekeeper(budget);
  expect(a.pake(run)).toEqual(ANSWER);
  expect(b.pake(run)).toEqual(ANSWER);
  expect(a.pake(run)).toEqual({ kind: "refuse", why: "budget" });
  // A refused pake spends no attempt of the guest's.
  expect(gatekeeper(budget).resume(true)).toEqual({ kind: "open" });
  // A failed first resume would show a code that can't be used.
  expect(gatekeeper(budget).resume(false)).toEqual({ kind: "refuse", why: "budget" });
  // A run already answered still finishes.
  expect(b.confirm(() => true)).toEqual({ kind: "open" });
});
