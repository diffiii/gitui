import { expect, test } from "bun:test";
import {
  MAX_OFFERS_PER_MINUTE,
  MAX_PENDING,
  MAX_REFUSALS_PER_WINDOW,
  RATE_WINDOW,
} from "@gitui/shared";
import { PairingBudget } from "./auth.ts";
import { BUSY_LINE, OfferLimiter } from "./offers.ts";

function limiter(budgetLimit = 10) {
  let now = 0;
  const budget = new PairingBudget({ limit: budgetLimit, now: () => now });
  return {
    limiter: new OfferLimiter(budget, () => now),
    budget,
    tick: (ms: number) => (now += ms),
  };
}

test("too many pending guests is busy; the line is said once until an offer gets through", () => {
  const { limiter: offers } = limiter();
  expect(offers.admit(MAX_PENDING - 1, false)).toEqual({ ok: true });
  expect(offers.admit(MAX_PENDING, false)).toEqual({
    ok: false,
    reason: "busy",
    line: BUSY_LINE,
    tell: true,
  });
  expect(offers.admit(MAX_PENDING, true)).toMatchObject({ reason: "busy", line: null });
  expect(offers.admit(0, false)).toEqual({ ok: true });
  expect(offers.admit(MAX_PENDING, false)).toMatchObject({ line: BUSY_LINE });
});

test("offers per minute are capped", () => {
  const { limiter: offers, tick } = limiter();
  for (let i = 0; i < MAX_OFFERS_PER_MINUTE; i++) expect(offers.admit(0, false).ok).toBe(true);
  expect(offers.admit(0, true)).toMatchObject({ reason: "rate-limited", line: BUSY_LINE });
  tick(60_000);
  expect(offers.admit(0, false).ok).toBe(true);
});

test("while the pairing budget is out, only offers that resume are taken", () => {
  const { limiter: offers, budget } = limiter(1);
  budget.spend();
  // The budget printed its own line.
  expect(offers.admit(0, false)).toEqual({
    ok: false,
    reason: "pairing-locked",
    line: null,
    tell: true,
  });
  expect(offers.admit(0, true)).toEqual({ ok: true });
});

test("the first limit that applies is the reason", () => {
  const { limiter: offers, budget } = limiter(1);
  budget.spend();
  for (let i = 0; i < MAX_OFFERS_PER_MINUTE; i++) offers.admit(0, true);
  expect(offers.admit(MAX_PENDING, false)).toMatchObject({ reason: "busy" });
  expect(offers.admit(0, false)).toMatchObject({ reason: "rate-limited" });
});

test("refusals are told at most MAX_REFUSALS_PER_WINDOW times in any RATE_WINDOW", () => {
  const { limiter: offers, tick } = limiter();
  const told = () => {
    let n = 0;
    for (let i = 0; i < 3 * MAX_REFUSALS_PER_WINDOW; i++) {
      const admission = offers.admit(MAX_PENDING, false);
      if (!admission.ok && admission.tell) n++;
    }
    return n;
  };
  expect(told()).toBe(MAX_REFUSALS_PER_WINDOW);
  tick(RATE_WINDOW - 1);
  expect(told()).toBe(0);
  tick(1);
  expect(told()).toBe(MAX_REFUSALS_PER_WINDOW);
});
