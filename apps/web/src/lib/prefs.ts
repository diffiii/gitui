import { useSyncExternalStore } from "react";
import { findPalette, type PaletteId } from "./themes.ts";

/** Tiny localStorage-backed preference store usable from any component. */
function createPref<T extends string>(key: string, fallback: T) {
  const listeners = new Set<() => void>();
  let value: T = fallback;
  try {
    value = (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    // storage unavailable
  }
  const set = (v: T) => {
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

export type Theme = "light" | "dark" | "system";
export type DiffStyle = "unified" | "split";

const useThemePref = createPref<Theme>("gitui-theme", "system");
export const usePalette = createPref<PaletteId>("gitui-palette", "neutral");
export const useDiffStyle = createPref<DiffStyle>("gitui-diff-style", "unified");
export const useHistoryDetails = createPref<"open" | "closed">("gitui-history-details", "open");

const media = window.matchMedia("(prefers-color-scheme: dark)");
const subscribeMedia = (cb: () => void) => {
  media.addEventListener("change", cb);
  return () => media.removeEventListener("change", cb);
};

const resolveTheme = (theme: Theme, systemDark: boolean): "light" | "dark" =>
  theme === "system" ? (systemDark ? "dark" : "light") : theme;

export function useTheme() {
  const [theme, setTheme] = useThemePref();
  const [palette] = usePalette();
  const systemDark = useSyncExternalStore(subscribeMedia, () => media.matches);
  return {
    theme,
    resolved: resolveTheme(theme, systemDark),
    setTheme,
    palette: findPalette(palette),
  };
}

// Keep the theme class and palette on <html> in sync, outside React, so they are right before
// first render. public/theme.js does the same before the app loads.
function applyTheme() {
  const root = document.documentElement;
  const resolved = resolveTheme(useThemePref.get(), media.matches);
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  const palette = findPalette(usePalette.get()).id;
  if (palette === "neutral") delete root.dataset.palette;
  else root.dataset.palette = palette;
}
applyTheme();
useThemePref.subscribe(applyTheme);
usePalette.subscribe(applyTheme);
subscribeMedia(applyTheme);
