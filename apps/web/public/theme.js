// Applies the saved theme before first paint. A file rather than an inline script, so the
// hosted app's CSP can stay at script-src 'self'.
try {
  const t = localStorage.getItem("gitui-theme");
  if (t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches))
    document.documentElement.classList.add("dark");
} catch {
  // storage unavailable: prefs.ts applies the theme once the app loads
}
