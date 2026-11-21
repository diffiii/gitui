// A named import: Bun's bundler (scripts/build.ts) keeps only the string that is used, not the
// whole package.json. A JSON import like this works under Bun and in the bundle, not in plain
// Node ESM, which is fine: Node only runs the bundle.
import { version } from "../package.json" with { type: "json" };

/** This CLI's version, from its package.json. */
export const VERSION: string = version;
