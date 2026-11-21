import { Button } from "@/components/ui/button";
import { select, useUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/views";
import { BranchesView } from "./BranchesView";
import { ChangesView } from "./ChangesView";
import { FilesView } from "./FilesView";
import { HistoryPane } from "./HistoryView";

// The repo's views, with the diff and file-tree code they bring: App.tsx loads this module on
// demand, so the connect screen and the repository picker don't download it (vite.config.ts fails
// the build if the main chunk has that code).

export function RepoViews({ view }: { view: View }) {
  return (
    <>
      {view === "changes" && <ChangesView />}
      {view === "history" && <HistoryView />}
      {view === "branches" && <BranchesView />}
      {view === "files" && <FilesView />}
    </>
  );
}

function HistoryView() {
  const { all } = useUrl();
  return (
    <HistoryPane
      key={String(all)}
      all={all}
      toolbar={
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5 text-xs">
          {[
            { v: false, label: "Current branch" },
            { v: true, label: "All branches" },
          ].map((o) => (
            <Button
              key={o.label}
              size="xs"
              variant={all === o.v ? "secondary" : "ghost"}
              className={cn(
                "touch-target",
                all === o.v ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
              // The other list starts at its newest commit.
              onClick={() => select({ all: o.v, commit: null })}
            >
              {o.label}
            </Button>
          ))}
        </div>
      }
    />
  );
}
