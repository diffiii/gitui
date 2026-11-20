import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import { isApiError } from "@/lib/connection";
import { RepoProvider } from "@/lib/repo";
import { useStatus } from "@/lib/status";
import { openRepo, select, setView, useUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/views";
import { AppHeader } from "./components/AppHeader";
import { BranchesView } from "./components/BranchesView";
import { ChangesView } from "./components/ChangesView";
import { FilesView } from "./components/FilesView";
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
              <OpenedRepo repo={repo}>
                {view === "changes" && <ChangesView />}
                {view === "history" && <HistoryView />}
                {view === "branches" && <BranchesView />}
                {view === "files" && <FilesView />}
              </OpenedRepo>
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

/**
 * The repo's views, unless this device may only use repositories opened on the computer and
 * `repo` isn't one (a link from elsewhere): then the picker, saying so. The views wait for the
 * repo's first status, so such a repo doesn't flash their errors first; the status keeps polling,
 * so the views come up once the repo is opened on the computer.
 */
function OpenedRepo({ repo, children }: { repo: string; children: React.ReactNode }) {
  const { data, error } = useStatus();
  // A query without data drops its error while it fetches again, so the verdict is kept until
  // the next one (adjusting state while rendering, as React's docs describe), and the screen
  // doesn't flash away on every poll, or for as long as a nearby session reconnects.
  const [kept, setKept] = useState(false);
  const notOpened = isApiError(error, "not-opened") || (kept && data === undefined && !error);
  if (notOpened !== kept) setKept(notOpened);
  if (notOpened) {
    return (
      <RepoWelcome
        onOpen={openRepo}
        notOpened={repo}
        className="h-full min-h-0 overflow-y-auto p-4"
      />
    );
  }
  if (data === undefined && !error) {
    // It fades in late, so a quick first status doesn't flash it.
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex h-full animate-in items-center justify-center fade-in fill-mode-backwards delay-300 duration-300"
      >
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return children;
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
