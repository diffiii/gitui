import type { AppConfig } from "./api.ts";
import type { Connection } from "./connection.ts";

/**
 * Whether the app must ask the user before it opens `repo`, the URL's repo (`?repo=`). On this
 * computer gitui runs git in any repository it's asked to, with that repository's own config, so a
 * link naming one gitui hasn't opened (not its initial repo, not in its recent list) waits for a
 * yes. A config that didn't load can't vouch for anything, so it asks too. A nearby device skips
 * this: the CLI only lets it use opened repositories, and says so (`notOpened`). Paths are
 * compared exactly; opening one resolves it to its root.
 */
export function asksBeforeOpening(
  config: Pick<AppConfig, "initialRepo" | "recent"> | undefined,
  repo: string,
  connection: Connection["kind"],
): boolean {
  if (connection === "nearby") return false;
  if (!config) return true;
  return repo !== config.initialRepo && !config.recent.includes(repo);
}
