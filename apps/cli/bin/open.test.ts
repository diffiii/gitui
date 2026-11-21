import { expect, test } from "bun:test";
import { openBrowser } from "./open.ts";

test("a missing opener is reported, not thrown", async () => {
  const error = await new Promise<Error>((resolve) =>
    openBrowser("https://example.invalid/", resolve, ["gitui-test-no-such-opener"]),
  );
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
});
