// The host's pure auth decisions: the pairing budget and a guest's Gatekeeper.
import { expect, test } from "bun:test";
import { AUTH_ATTEMPTS } from "@gitui/shared";
import { Gatekeeper, PAIRING_BUDGET, PAIRING_WINDOW, PairingBudget } from "./auth.ts";

/** A budget on a clock the test moves. */
function clocked(limit = PAIRING_BUDGET) {
  let now = 1_000_000;
  let exhausted = 0;
  const budget = new PairingBudget({ limit, now: () => now, onExhausted: () => exhausted++ });
  return {
    budget,
    tick: (ms: number) => (now += ms),
    get exhausted() {
      return exhausted;
    },
  };
}

test("the budget rolls over its window and says each time it runs out", () => {
  const clock = clocked(3);
  const { budget } = clock;
  expect(budget.spend()).toBe(true);
  clock.tick(PAIRING_WINDOW / 2);
  expect(budget.spend()).toBe(true);
  expect(clock.exhausted).toBe(0);
  expect(budget.spend()).toBe(true);
  expect(clock.exhausted).toBe(1);
  expect(budget.exhausted).toBe(true);
  expect(budget.spend()).toBe(false);
  expect(clock.exhausted).toBe(1);
  // The first spend leaves the window; one more fits, and the budget runs out again.
  clock.tick(PAIRING_WINDOW / 2);
  expect(budget.left).toBe(1);
  expect(budget.spend()).toBe(true);
  expect(clock.exhausted).toBe(2);
  clock.tick(PAIRING_WINDOW);
  expect(budget.left).toBe(3);
});

test(`a wrong code fails ${AUTH_ATTEMPTS} times, then every try is refused`, () => {
  const gate = new Gatekeeper(new PairingBudget());
  for (let left = AUTH_ATTEMPTS - 1; left > 0; left--) {
    expect(gate.pake()).toEqual({ kind: "answer" });
    expect(gate.confirm(false)).toEqual({ kind: "fail", attemptsLeft: left });
  }
  expect(gate.pake()).toEqual({ kind: "answer" });
  expect(gate.confirm(false)).toEqual({ kind: "refuse", why: "attempts" });
  expect(gate.pake()).toEqual({ kind: "refuse", why: "attempts" });
  expect(gate.resume(true)).toEqual({ kind: "refuse", why: "attempts" });
});

test("the right code opens; a new pake gives up on the run before it", () => {
  const gate = new Gatekeeper(new PairingBudget());
  expect(gate.pake()).toEqual({ kind: "answer" });
  expect(gate.pake()).toEqual({ kind: "answer" });
  expect(gate.attemptsLeft).toBe(AUTH_ATTEMPTS - 2);
  expect(gate.confirm(true)).toEqual({ kind: "open", via: "code" });
});

test("a confirmation without a run breaks the protocol", () => {
  const gate = new Gatekeeper(new PairingBudget());
  expect(gate.confirm(true)).toEqual({ kind: "violation" });
  gate.pake();
  gate.confirm(false);
  expect(gate.confirm(true)).toEqual({ kind: "violation" });
});

test("a first resume is free if it fails; later ones spend attempts", () => {
  const gate = new Gatekeeper(new PairingBudget());
  expect(gate.resume(false)).toEqual({ kind: "fail", attemptsLeft: AUTH_ATTEMPTS });
  expect(gate.resume(false)).toEqual({ kind: "fail", attemptsLeft: AUTH_ATTEMPTS - 1 });
  expect(gate.resume(true)).toEqual({ kind: "open", via: "resume" });

  const first = new Gatekeeper(new PairingBudget());
  expect(first.resume(true)).toEqual({ kind: "open", via: "resume" });
});

test("the budget is shared: once it is out, no pake is answered, and resumes still work", () => {
  const { budget } = clocked(2);
  const a = new Gatekeeper(budget);
  const b = new Gatekeeper(budget);
  expect(a.pake()).toEqual({ kind: "answer" });
  expect(b.pake()).toEqual({ kind: "answer" });
  expect(a.pake()).toEqual({ kind: "refuse", why: "budget" });
  // A refused pake spends no attempt of the guest's.
  expect(new Gatekeeper(budget).resume(true)).toEqual({ kind: "open", via: "resume" });
  // A failed first resume would show a code that can't be used.
  expect(new Gatekeeper(budget).resume(false)).toEqual({ kind: "refuse", why: "budget" });
  // A run already answered still finishes.
  expect(b.confirm(true)).toEqual({ kind: "open", via: "code" });
});
