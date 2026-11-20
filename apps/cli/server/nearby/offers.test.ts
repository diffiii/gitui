import { expect, test } from "bun:test";
import { MAX_PENDING } from "@gitui/shared";
import { PairingBudget } from "./auth.ts";
import { BUSY_LINE, MAX_OFFERS_PER_MINUTE, OfferLimiter } from "./offers.ts";

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
  expect(offers.admit(MAX_PENDING, false)).toEqual({ ok: false, reason: "busy", line: BUSY_LINE });
  expect(offers.admit(MAX_PENDING, true)).toEqual({ ok: false, reason: "busy", line: null });
  expect(offers.admit(0, false)).toEqual({ ok: true });
  expect(offers.admit(MAX_PENDING, false)).toMatchObject({ line: BUSY_LINE });
});

test("offers per minute are capped", () => {
  const { limiter: offers, tick } = limiter();
  for (let i = 0; i < MAX_OFFERS_PER_MINUTE; i++) expect(offers.admit(0, false).ok).toBe(true);
  expect(offers.admit(0, true)).toEqual({ ok: false, reason: "rate-limited", line: BUSY_LINE });
  tick(60_000);
  expect(offers.admit(0, false).ok).toBe(true);
});

test("while the pairing budget is out, only offers that resume are taken", () => {
  const { limiter: offers, budget } = limiter(1);
  budget.spend();
  // The budget printed its own line.
  expect(offers.admit(0, false)).toEqual({ ok: false, reason: "rate-limited", line: null });
  expect(offers.admit(0, true)).toEqual({ ok: true });
});
