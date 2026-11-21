// What the CLI keeps in ~/.config/gitui (or $XDG_CONFIG_HOME/gitui).
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Effect, FileSystem, Schema } from "effect";

export const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "gitui",
);
const recentFile = (dir: string) => path.join(dir, "recent.json");

/** recent.json: a JSON array, of which only the strings count. */
const RecentFile = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const decodeRecent = Schema.decodeUnknownEffect(RecentFile);

/** The recently opened repositories in `<dir>/recent.json`, newest first. */
export const readRecent = (
  dir = CONFIG_DIR,
): Effect.Effect<string[], never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(recentFile(dir))).pipe(
    Effect.flatMap(decodeRecent),
    Effect.map((list) => list.filter((r) => typeof r === "string")),
    // No file, or one that isn't a list, is an empty list.
    Effect.orElseSucceed((): string[] => []),
  );

/** Puts `repo` first in the recent list, which keeps the last 20. */
export const pushRecent = Effect.fnUntraced(function* (repo: string, dir = CONFIG_DIR) {
  const fs = yield* FileSystem.FileSystem;
  const list = [repo, ...(yield* readRecent(dir)).filter((r) => r !== repo)].slice(0, 20);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(recentFile(dir), JSON.stringify(list, null, 2));
});

const TOKEN = /^[\w-]{43}$/; // 32 bytes, base64url

/**
 * The pairing token in `<dir>/token`, created (mode 0600) on first use and reused afterwards,
 * so a browser's saved pairing survives CLI restarts. Delete the file to rotate it. A file that
 * doesn't hold a valid token (empty, hand-edited) is replaced.
 */
export const loadToken = Effect.fnUntraced(function* (dir = CONFIG_DIR) {
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(dir, "token");
  for (;;) {
    const existing = yield* fs
      .readFileString(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (existing !== null) {
      if (TOKEN.test(existing.trim())) return existing.trim();
      yield* fs.remove(file, { force: true });
    }
    const token = randomBytes(32).toString("base64url");
    yield* fs.makeDirectory(dir, { recursive: true });
    // "wx": another CLI starting at the same moment may have just created it; then use theirs.
    const created = yield* fs.writeFileString(file, token, { mode: 0o600, flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );
    if (created) return token;
  }
});
