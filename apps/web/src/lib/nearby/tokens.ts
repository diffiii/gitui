import { HOST_KEY } from "@gitui/shared";

// Resume tokens (the `session` message), saved by host key so a reload, or a connection iOS
// dropped, opens with `resume` instead of asking for the code again. A token lasts as long as the
// CLI run that made it, and each run has a new key, so old entries are dead weight: only the
// most recently saved MAX_TOKENS are kept.

/** The parts of Storage the store uses. */
export type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const TOKENS_KEY = "gitui-nearby-tokens";
export const MAX_TOKENS = 8;

type Tokens = [key: string, token: string][];

/** The saved entries, oldest first; anything malformed reads as none. */
export function parseTokens(saved: string | null): Tokens {
  try {
    const value: unknown = JSON.parse(saved ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (e): e is [string, string] =>
        Array.isArray(e) &&
        e.length === 2 &&
        typeof e[0] === "string" &&
        HOST_KEY.test(e[0]) &&
        typeof e[1] === "string" &&
        e[1].length > 0,
    );
  } catch {
    return [];
  }
}

/** `tokens` with `key` set to `token` (or removed, for null) as the newest entry. */
export function withToken(tokens: Tokens, key: string, token: string | null): Tokens {
  const rest = tokens.filter(([k]) => k !== key);
  return token === null ? rest : [...rest, [key, token] as [string, string]].slice(-MAX_TOKENS);
}

export interface TokenStore {
  load(key: string): string | null;
  save(key: string, token: string): void;
  forget(key: string): void;
}

/** A token store over `storage`; without one (private mode, blocked), tokens last for the page. */
export function tokenStore(storage: () => TokenStorage | undefined): TokenStore {
  let memory: Tokens = [];
  const read = (): Tokens => {
    try {
      const s = storage();
      return s ? parseTokens(s.getItem(TOKENS_KEY)) : memory;
    } catch {
      return memory;
    }
  };
  const write = (tokens: Tokens) => {
    memory = tokens;
    try {
      const s = storage();
      if (!s) return;
      if (tokens.length) s.setItem(TOKENS_KEY, JSON.stringify(tokens));
      else s.removeItem(TOKENS_KEY);
    } catch {
      // storage unavailable: the token lasts for this page load
    }
  };
  return {
    load: (key) => read().find(([k]) => k === key)?.[1] ?? null,
    save: (key, token) => write(withToken(read(), key, token)),
    forget: (key) => write(withToken(read(), key, null)),
  };
}

/** The page's tokens, in localStorage. */
export const tokens = tokenStore(() =>
  typeof localStorage === "undefined" ? undefined : localStorage,
);
