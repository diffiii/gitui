// What the CLI keeps in ~/.config/gitui (or $XDG_CONFIG_HOME/gitui).
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "gitui",
);
const recentFile = (dir: string) => path.join(dir, "recent.json");

/** The recently opened repositories in `<dir>/recent.json`, newest first. */
export async function readRecent(dir = CONFIG_DIR): Promise<string[]> {
  try {
    const list: unknown = JSON.parse(await readFile(recentFile(dir), "utf8"));
    return Array.isArray(list) ? list.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** Puts `repo` first in the recent list, which keeps the last 20. */
export async function pushRecent(repo: string, dir = CONFIG_DIR) {
  const list = [repo, ...(await readRecent(dir)).filter((r) => r !== repo)].slice(0, 20);
  await mkdir(dir, { recursive: true });
  await writeFile(recentFile(dir), JSON.stringify(list, null, 2));
}

const TOKEN = /^[\w-]{43}$/; // 32 bytes, base64url

/**
 * The pairing token in `<dir>/token`, created (mode 0600) on first use and reused afterwards,
 * so a browser's saved pairing survives CLI restarts. Delete the file to rotate it. A file that
 * doesn't hold a valid token (empty, hand-edited) is replaced.
 */
export async function loadToken(dir = CONFIG_DIR): Promise<string> {
  const file = path.join(dir, "token");
  for (;;) {
    const existing = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (existing !== null) {
      if (TOKEN.test(existing.trim())) return existing.trim();
      await rm(file, { force: true });
    }
    const token = randomBytes(32).toString("base64url");
    await mkdir(dir, { recursive: true });
    try {
      // "wx": another CLI starting at the same moment may have just created it; then use theirs.
      await writeFile(file, token, { mode: 0o600, flag: "wx" });
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
