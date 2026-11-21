// The app serves @gitui/shared's API contract: every endpoint of it, and no other (the 404
// catch-alls aside), with the answers it declares, which the type checks below hold it to.
import { expect, test } from "bun:test";
import { API } from "@gitui/shared";
import { Effect } from "effect";
import { API_ROUTES, type ApiRoute, type RouteAnswer, type RouteTable } from "./app.ts";

test("the routes served are exactly the contract's endpoints", () => {
  const served = API_ROUTES.filter((r) => r.path !== "/api/*").map((r) => `${r.method} ${r.path}`);
  const contract = Object.values(API).map((e) => `${e.method} ${e.path}`);
  expect(new Set(served)).toEqual(new Set(contract));
  expect(served).toHaveLength(contract.length);
});

/**
 * What the type check refuses, for `tsc -b` (never called): an answer that isn't the contract's
 * response for its key, and a route table that misses an endpoint or serves one the contract
 * doesn't have.
 */
export function refusedByTheTypeCheck(
  all: RouteTable,
  withoutCheckout: Omit<RouteTable, "checkout">,
  route: ApiRoute,
) {
  const answers: RouteAnswer<"lastMessage">[] = [
    Effect.succeed({ message: "x" }),
    // @ts-expect-error: the contract's lastMessage answers `{ message }`.
    Effect.succeed({ msg: "x" }),
  ];
  const tables: RouteTable[] = [
    all,
    // @ts-expect-error: checkout is an endpoint of the contract.
    withoutCheckout,
    // @ts-expect-error: extra isn't.
    { ...all, extra: route },
  ];
  return [answers, tables];
}
