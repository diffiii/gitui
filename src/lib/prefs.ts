import { useEffect, useSyncExternalStore } from "react";

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
  return () => [useSyncExternalStore(subscribe, () => value), set] as const;
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

export function useTheme() {
  const [theme, setTheme] = useThemePref();
  const systemDark = useSyncExternalStore(subscribeMedia, () => media.matches);
  const resolved: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return { theme, resolved, setTheme };
}

/** Mount once at the root to apply the theme class to <html>. */
export function useApplyTheme() {
  const { resolved } = useTheme();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);
}
