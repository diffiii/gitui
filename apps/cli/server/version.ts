// A named import, so the bundle inlines only this string (scripts/build.ts), not package.json.
import { version } from "../package.json" with { type: "json" };

/** This CLI's version, from its package.json. */
export const VERSION: string = version;
