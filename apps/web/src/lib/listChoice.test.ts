import { expect, test } from "bun:test";
import { opensDetail, shownItem } from "./listChoice.ts";

test("a chosen item is shown in either layout", () => {
  expect(shownItem("b", "a", false)).toBe("b");
  expect(shownItem("b", "a", true)).toBe("b");
});

test("with nothing chosen, side-by-side panes show the first item and stacked ones the list", () => {
  expect(shownItem(null, "a", false)).toBe("a");
  expect(shownItem(null, "a", true)).toBeNull();
  expect(shownItem(null, null, false)).toBeNull();
});

test("choosing opens a detail entry only from a stacked list", () => {
  expect(opensDetail("commit", true, null)).toBe("commit");
  // the detail already covers the list: switching what it shows doesn't add an entry
  expect(opensDetail("commit", true, "a")).toBeUndefined();
  // side by side, selecting replaces
  expect(opensDetail("commit", false, null)).toBeUndefined();
  expect(opensDetail("commit", false, "a")).toBeUndefined();
});
