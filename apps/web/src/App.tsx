import { useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import { RepoProvider } from "@/lib/repo";
import { openRepo, select, setView, useUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/views";
import { AppHeader } from "./components/AppHeader";
import { BranchesView } from "./components/BranchesView";
import { ChangesView } from "./components/ChangesView";
import { HistoryPane } from "./components/HistoryView";
import { RepoWelcome } from "./components/RepoPicker";
import { Button } from "./components/ui/button";
import { ViewTabBar } from "./components/ViewTabs";

export default function App() {
  const { repo: urlRepo, view } = useUrl();
  const { data: config, isLoading } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // `gitui <path>` passes the repo to the server; use it while the URL has none.
  const repo = urlRepo ?? config?.initialRepo ?? null;

  const onView = (v: View) => setView(repo, v);

  return (
    <TooltipProvider delayDuration={400}>
      <title>{repo ? `${repo.split("/").pop()} · gitui` : "gitui"}</title>
      {repo ? (
        <RepoProvider key={repo} repo={repo}>
          {/* viewport-fit=cover (index.html) lays the page under iOS's notch and home indicator. */}
          <div className="flex h-svh flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:pb-[env(safe-area-inset-bottom)]">
            <AppHeader view={view} onView={onView} onOpenRepo={openRepo} />
            <main className="min-h-0 flex-1">
              {view === "changes" && <ChangesView />}
              {view === "history" && <HistoryView />}
              {view === "branches" && <BranchesView />}
            </main>
            <ViewTabBar view={view} onView={onView} />
          </div>
        </RepoProvider>
      ) : isLoading ? null : (
        <RepoWelcome onOpen={openRepo} />
      )}
      <Toaster
        position="bottom-right"
        offset={{ bottom: "var(--toaster-bottom)" }}
        mobileOffset={{ bottom: "var(--toaster-mobile-bottom)" }}
      />
    </TooltipProvider>
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
