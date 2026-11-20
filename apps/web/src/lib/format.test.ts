import { expect, test } from "bun:test";
import { formatBytes, shortAge } from "./format.ts";

test("shortAge names the largest whole unit", () => {
  const now = 1_000_000_000;
  expect(shortAge(now - 30, now)).toBe("now");
  expect(shortAge(now - 59 * 60, now)).toBe("59m");
  expect(shortAge(now - 3 * 3600 - 1, now)).toBe("3h");
  expect(shortAge(now - 6 * 86400, now)).toBe("6d");
  expect(shortAge(now - 15 * 86400, now)).toBe("2w");
  expect(shortAge(now - 65 * 86400, now)).toBe("2mo");
  expect(shortAge(now - 800 * 86400, now)).toBe("2y");
});

test("shortAge treats future dates (clock skew) as now", () => {
  expect(shortAge(2000, 1000)).toBe("now");
});

test("formatBytes names the largest unit the size fills", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(2.3 * 1024 * 1024)).toBe("2.3 MB");
  expect(formatBytes(5 * 1024 ** 4)).toBe("5120.0 GB");
});
