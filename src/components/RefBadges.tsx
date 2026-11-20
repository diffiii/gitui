import { Cloud, GitBranch, Tag } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ParsedRef {
  kind: "head" | "branch" | "remote" | "tag" | "detached";
  name: string;
}

/** Parses `%D` output produced with `--decorate=full`. */
export function parseRefs(refs: string[]): ParsedRef[] {
  const out: ParsedRef[] = [];
  for (const r of refs) {
    if (r === "HEAD") out.push({ kind: "detached", name: "HEAD" });
    else if (r.startsWith("HEAD -> "))
      out.push({ kind: "head", name: r.slice(8).replace(/^refs\/heads\//, "") });
    else if (r.startsWith("tag: "))
      out.push({ kind: "tag", name: r.slice(5).replace(/^refs\/tags\//, "") });
    else if (r.startsWith("refs/heads/")) out.push({ kind: "branch", name: r.slice(11) });
    else if (r.startsWith("refs/remotes/")) {
      if (!r.endsWith("/HEAD")) out.push({ kind: "remote", name: r.slice(13) });
    } else if (!r.startsWith("refs/stash")) out.push({ kind: "branch", name: r });
  }
  return out;
}

const STYLE: Record<ParsedRef["kind"], string> = {
  head: "border-primary/30 bg-primary text-primary-foreground",
  detached: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  branch: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  remote: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  tag: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export function RefBadges({ refs, className }: { refs: string[]; className?: string }) {
  const parsed = parseRefs(refs);
  if (!parsed.length) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {parsed.map((r) => {
        const Icon = r.kind === "tag" ? Tag : r.kind === "remote" ? Cloud : GitBranch;
        return (
          <span
            key={r.kind + r.name}
            className={cn(
              "inline-flex h-[18px] max-w-48 items-center gap-1 rounded-md border px-1.5 text-[11px] leading-none font-medium",
              STYLE[r.kind],
            )}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{r.name}</span>
          </span>
        );
      })}
    </span>
  );
}
