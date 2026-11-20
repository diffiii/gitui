import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The pairing token in `<dir>/token`, created (mode 0600) on first use and reused afterwards,
 * so a browser's saved pairing survives CLI restarts.
 */
export async function loadToken(dir: string): Promise<string> {
  const file = path.join(dir, "token");
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dir, { recursive: true });
  await writeFile(file, token, { mode: 0o600 });
  return token;
}
