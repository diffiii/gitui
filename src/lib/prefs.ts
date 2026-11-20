import { useSyncExternalStore } from "react";

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
  const systemDark = useSyncExternalStore(subscribeMedia, () => media.matches);
  return { theme, resolved: resolveTheme(theme, systemDark), setTheme };
}

// Keep the theme class on <html> in sync, outside React, so it is right before first render.
function applyTheme() {
  const resolved = resolveTheme(useThemePref.get(), media.matches);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}
applyTheme();
useThemePref.subscribe(applyTheme);
subscribeMedia(applyTheme);
