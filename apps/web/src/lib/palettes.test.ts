import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PALETTE_IDS } from "./palettes.ts";

const css = readFileSync(path.join(import.meta.dir, "../palettes.css"), "utf8");

/** The custom properties a palette rule sets, keyed by its selector. */
function rule(selector: string): string[] {
  const at = css.indexOf(`${selector} {`);
  expect(at, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf("}", at));
  return [...body.matchAll(/(--[\w-]+):/g)].map((m) => m[1]).sort();
}

test("every palette has light and dark colors in palettes.css, and nothing else does", () => {
  const inCss = new Set([...css.matchAll(/\[data-palette="([\w-]+)"\]/g)].map((m) => m[1]));
  expect([...inCss].sort()).toEqual([...PALETTE_IDS].sort());
});

test("each palette's dark rule overrides everything its light rule sets", () => {
  // A property set only in the light rule would leak into dark mode.
  for (const id of PALETTE_IDS) {
    const light = rule(`[data-palette="${id}"]`);
    const dark = rule(`.dark [data-palette="${id}"]`);
    expect(
      light.filter((p) => !dark.includes(p)),
      id,
    ).toEqual([]);
  }
});
