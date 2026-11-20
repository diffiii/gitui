// Applies the saved theme and palette (src/lib/prefs.ts) before first paint. A file rather than
// an inline script, so the hosted app's CSP can stay at script-src 'self'.
try {
  const t = localStorage.getItem("gitui-theme");
  if (t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches))
    document.documentElement.classList.add("dark");
  const p = localStorage.getItem("gitui-palette");
  if (p && p !== "neutral") document.documentElement.dataset.palette = p;
} catch {
  // storage unavailable: prefs.ts applies the theme once the app loads
}
