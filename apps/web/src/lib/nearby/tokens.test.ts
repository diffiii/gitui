import { expect, test } from "bun:test";
import { MAX_TOKENS, parseTokens, tokenStore, TOKENS_KEY, type TokenStorage } from "./tokens.ts";

const key = (n: number) => `host-${String(n).padStart(11, "0")}`;

function memoryStorage() {
  const map = new Map<string, string>();
  const storage: TokenStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return { map, storage };
}

test("saves, loads and forgets a token per host key", () => {
  const { map, storage } = memoryStorage();
  const tokens = tokenStore(() => storage);
  expect(tokens.load(key(1))).toBeNull();
  tokens.save(key(1), "one");
  tokens.save(key(2), "two");
  tokens.save(key(1), "uno");
  expect([tokens.load(key(1)), tokens.load(key(2))]).toEqual(["uno", "two"]);
  expect(JSON.parse(map.get(TOKENS_KEY)!)).toEqual([
    [key(2), "two"],
    [key(1), "uno"],
  ]);
  tokens.forget(key(2));
  tokens.forget(key(1));
  expect(tokens.load(key(1))).toBeNull();
  expect(map.has(TOKENS_KEY)).toBe(false);
});

test("keeps only the newest MAX_TOKENS", () => {
  const { storage } = memoryStorage();
  const tokens = tokenStore(() => storage);
  for (let n = 0; n <= MAX_TOKENS; n++) tokens.save(key(n), `t${n}`);
  expect(tokens.load(key(0))).toBeNull();
  expect(tokens.load(key(1))).toBe("t1");
  expect(tokens.load(key(MAX_TOKENS))).toBe(`t${MAX_TOKENS}`);
});

test("malformed saved tokens read as none", () => {
  expect(parseTokens(null)).toEqual([]);
  expect(parseTokens("not json")).toEqual([]);
  expect(parseTokens('{"a":1}')).toEqual([]);
  expect(
    parseTokens(JSON.stringify([[key(1), "ok"], ["bad key", "x"], [key(2), ""], [key(3)]])),
  ).toEqual([[key(1), "ok"]]);
});

test("without storage, tokens last for the page", () => {
  const tokens = tokenStore(() => {
    throw new Error("SecurityError");
  });
  tokens.save(key(1), "one");
  expect(tokens.load(key(1))).toBe("one");
  tokens.forget(key(1));
  expect(tokens.load(key(1))).toBeNull();
});
