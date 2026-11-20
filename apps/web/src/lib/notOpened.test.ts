import { expect, test } from "bun:test";
import { ApiError } from "./connection.ts";
import { notOpened } from "./notOpened.ts";

const refused = new ApiError("not opened", "not-opened");

test("a not-opened error is the verdict, and stands while the status fetches again", () => {
  expect(notOpened(false, { data: undefined, error: refused })).toBe(true);
  expect(notOpened(true, { data: undefined, error: null })).toBe(true);
});

test("a status, or another error, ends the verdict", () => {
  expect(notOpened(true, { data: { files: [] }, error: null })).toBe(false);
  expect(notOpened(true, { data: undefined, error: new ApiError("boom", "http") })).toBe(false);
});

test("without a verdict, a status still loading isn't one", () => {
  expect(notOpened(false, { data: undefined, error: null })).toBe(false);
});
