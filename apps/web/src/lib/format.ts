const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

export function relativeTime(unixSeconds: number) {
  const diff = unixSeconds - Date.now() / 1000;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, secs] of units)
    if (abs >= secs) return rtf.format(Math.round(diff / secs), unit);
  return "just now";
}

/** How long ago, in the fewest characters (`5m`, `3h`, `2mo`), for narrow columns. */
export function shortAge(unixSeconds: number, now = Date.now() / 1000) {
  const age = Math.max(0, now - unixSeconds);
  const units: [string, number][] = [
    ["y", 31536000],
    ["mo", 2592000],
    ["w", 604800],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  for (const [unit, secs] of units) if (age >= secs) return `${Math.floor(age / secs)}${unit}`;
  return "now";
}

export function fullDate(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** A byte count in the largest unit it fills: `512 B`, `2.3 MB`. */
export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

export function splitPath(p: string) {
  const i = p.lastIndexOf("/");
  return i === -1 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}
