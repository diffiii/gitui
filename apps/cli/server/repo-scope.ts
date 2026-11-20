// Which repositories a listener's clients may use (access.ts gives each listener its scope).
// Clients on this computer (loopback) may open any repository, and opening one puts it in the
// recent list. Clients on other devices (lan, nearby) may only use the repositories opened on
// this computer: the one gitui was started with and the recent list. They can pick from that
// list, but they can't name another path, and opening one doesn't change the list.
//
// app.ts sends every `?repo=` and every `/open` through the listener's RepoGate; the
// repo-scope test checks that every route under /api/repo goes through it. A route that takes a
// repository path anywhere else (a field of its body, say) must send it through
// `repos.resolve` too, and test it with that field set: the gate's middleware only sees `?repo=`.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR, pushRecent, readRecent } from "./config.ts";
import { expandHome, resolveRepo } from "./git.ts";

/**
 * Which repositories a listener's clients may use: `any` path they name, or only those `opened`
 * on this computer (the repository gitui was started with and the recent list).
 */
export type RepoScope = "any" | "opened";

/** A client asked for a repository outside its listener's scope. */
export class RepoNotOpenedError extends Error {
  constructor() {
    super("This repository wasn't opened on the computer running gitui");
  }
}

/** How a client's repository paths become repository roots. */
export interface RepoGate {
  /** The root of the repository at `input` (it or any folder in it); throws RepoNotOpenedError. */
  resolve(input: string): Promise<string>;
  /** As `resolve`, for a client opening the repository, which the gate may remember. */
  open(input: string): Promise<string>;
}

export interface RepoGateOptions {
  /** The repository gitui was started with (`gitui <path>`). */
  initialRepo?: string;
  /** Where the recent list lives; tests pass a temp dir. */
  configDir?: string;
}

/** `p` with symlinks resolved, or null if it doesn't exist. */
const real = (p: string) => realpath(p).catch(() => null);

/** The gate for a listener's `scope`. */
export function repoGate(scope: RepoScope, options: RepoGateOptions = {}): RepoGate {
  return scope === "any" ? anyRepo(options) : openedRepos(options);
}

/** Any repository; opening one puts it first in the recent list. */
function anyRepo({ configDir = CONFIG_DIR }: RepoGateOptions): RepoGate {
  return {
    resolve: resolveRepo,
    async open(input) {
      const root = await resolveRepo(input);
      await pushRecent(root, configDir);
      return root;
    },
  };
}

/**
 * Only the repositories opened on this computer, read on every request, since opening one here
 * changes the recent list. A path must lie in an opened repository before git runs in it (so a
 * client learns nothing about other folders), and its root must be an opened one itself (not a
 * nested repository). Paths compare with symlinks resolved.
 */
function openedRepos({ initialRepo, configDir = CONFIG_DIR }: RepoGateOptions): RepoGate {
  const allowed = async () => {
    const roots = [...(initialRepo ? [initialRepo] : []), ...(await readRecent(configDir))];
    const resolved = await Promise.all(roots.map(real));
    return new Set(resolved.filter((r) => r !== null));
  };
  const resolve = async (input: string) => {
    const [roots, target] = await Promise.all([allowed(), real(path.resolve(expandHome(input)))]);
    const inside = (root: string) => target === root || target?.startsWith(root + path.sep);
    if (!target || ![...roots].some(inside)) throw new RepoNotOpenedError();
    const root = await resolveRepo(target);
    if (!roots.has((await real(root)) ?? "")) throw new RepoNotOpenedError();
    return root;
  };
  return { resolve, open: resolve };
}
