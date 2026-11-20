import { useSyncExternalStore } from "react";
import { PALETTE_IDS } from "./palettes.ts";

/**
 * Tiny localStorage-backed preference store usable from any component. Only `values` are
 * accepted: anything else stored or set is ignored, and the first value is the default.
 */
function createPref<const T extends string>(key: string, values: readonly T[]) {
  const listeners = new Set<() => void>();
  const valid = (v: string | null): v is T => values.includes(v as T);
  let value: T = values[0];
  try {
    const stored = localStorage.getItem(key);
    if (valid(stored)) value = stored;
  } catch {
    // storage unavailable
  }
  /** Takes a string, e.g. a radio group's value, and ignores anything that isn't a value. */
  const set = (v: string) => {
    if (!valid(v)) return;
    value = v;
    try {
      localStorage.setItem(key, v);
    } catch {
      // ignore
    }
    listeners.forEach((l) => l());
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const get = () => value;
  const use = () => [useSyncExternalStore(subscribe, get), set] as const;
  return Object.assign(use, { get, subscribe });
}

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const useThemePref = createPref("gitui-theme", THEMES);
export const usePalette = createPref("gitui-palette", PALETTE_IDS);
export const useDiffStyle = createPref("gitui-diff-style", ["unified", "split"]);
export const useHistoryDetails = createPref("gitui-history-details", ["open", "closed"]);

const media = window.matchMedia("(prefers-color-scheme: dark)");
const subscribeMedia = (cb: () => void) => {
  media.addEventListener("change", cb);
  return () => media.removeEventListener("change", cb);
};

const resolveTheme = (theme: Theme, systemDark: boolean): "light" | "dark" =>
  theme === "system" ? (systemDark ? "dark" : "light") : theme;

export function useTheme() {
  const [theme, setTheme] = useThemePref();
  const systemDark = useSyncExternalStore(subscribeMedia, () => media.matches);
  return { theme, resolved: resolveTheme(theme, systemDark), setTheme };
}

// Keep the theme class and palette on <html> in sync, outside React, so they are right before
// first render. public/theme.js does the same before the app loads.
function applyTheme() {
  const root = document.documentElement;
  const resolved = resolveTheme(useThemePref.get(), media.matches);
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.palette = usePalette.get();
}
applyTheme();
useThemePref.subscribe(applyTheme);
usePalette.subscribe(applyTheme);
subscribeMedia(applyTheme);
