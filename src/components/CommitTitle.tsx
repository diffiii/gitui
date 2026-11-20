import { cn } from "@/lib/utils";

// Mirrors Refined GitHub's conventional-commits feature: only the standard commitlint types,
// colored like GitHub's default issue labels, with the scope as muted text after the label.
const CONVENTIONAL = /^(?<type>\w+)(?:\((?<scope>.+?)\))?(?<major>!)?: */;

const TYPES: Record<string, { label: string; color: string }> = {
  feat: { label: "Feature", color: "#a2eeef" },
  fix: { label: "Fix", color: "#d73a4a" },
  chore: { label: "Chore", color: "#ffffff" },
  revert: { label: "Revert", color: "#ffffff" },
  style: { label: "Style", color: "#ffffff" },
  docs: { label: "Docs", color: "#0075ca" },
  build: { label: "Build", color: "#d93f0b" },
  refactor: { label: "Refactor", color: "#006b75" },
  test: { label: "Test", color: "#fbca04" },
  ci: { label: "CI", color: "#c5def5" },
  perf: { label: "Performance", color: "#5319e7" },
};

export function parseConventionalCommit(title: string) {
  const m = CONVENTIONAL.exec(title);
  const type = m?.groups?.type && TYPES[m.groups.type.toLowerCase()];
  if (!m || !type) return null;
  const rest = title.slice(m[0].length);
  // A bare "ci:" would leave only the label, which is confusing.
  if (!rest.trim()) return null;
  return {
    label: m.groups!.major ? `${type.label}!` : type.label,
    color: type.color,
    scope: m.groups!.scope,
    rest,
  };
}

/** Black or white text, whichever reads better on a solid label background (light mode). */
function foreground(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#000" : "#fff";
}

export function CommitTitle({ title, className }: { title: string; className?: string }) {
  const cc = parseConventionalCommit(title);
  if (!cc) return <span className={cn("truncate", className)}>{title}</span>;
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      <span
        className="cc-label"
        data-neutral={cc.color === "#ffffff" || undefined}
        style={{ "--cc": cc.color, "--cc-fg": foreground(cc.color) } as React.CSSProperties}
      >
        {cc.label}
      </span>
      <span className="truncate">
        {cc.scope && <span className="text-muted-foreground">{cc.scope}: </span>}
        {cc.rest}
      </span>
    </span>
  );
}
