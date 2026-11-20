import { expect, test } from "bun:test";
import { shownItem } from "./listChoice.ts";

test("a chosen item is shown in either layout", () => {
  expect(shownItem("b", "a", false)).toBe("b");
  expect(shownItem("b", "a", true)).toBe("b");
});

test("with nothing chosen, side-by-side panes show the first item and stacked ones the list", () => {
  expect(shownItem(null, "a", false)).toBe("a");
  expect(shownItem(null, "a", true)).toBeNull();
  expect(shownItem(null, null, false)).toBeNull();
});
