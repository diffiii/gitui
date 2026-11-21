import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { type ComponentType, lazy, Suspense, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import { PAGE_OUTDATED } from "@/lib/nearby/errors";
import { notOpened } from "@/lib/notOpened";
import { RepoProvider } from "@/lib/repo";
import { useStatus } from "@/lib/status";
import { openRepo, setView, useUrl } from "@/lib/url";
import type { View } from "@/lib/views";
import { AppHeader } from "./components/AppHeader";
import { EmptyState } from "./components/EmptyState";
import { RepoWelcome } from "./components/RepoPicker";
import { Button } from "./components/ui/button";
import { ViewTabBar } from "./components/ViewTabs";

// The views load on demand (RepoViews.tsx says why). A failed load means this page was
// deployed over since it loaded, so the chunk is gone: only a reload helps.
const RepoViews = lazy(() =>
  import("./components/RepoViews").then(
    (m): { default: ComponentType<{ view: View }> } => ({ default: m.RepoViews }),
    (e: unknown) => {
      console.error(e);
      return { default: PageOutdated };
    },
  ),
);

function PageOutdated() {
  return (
    <EmptyState icon={RefreshCw} title={PAGE_OUTDATED}>
      <Button size="sm" variant="outline" onClick={() => location.reload()}>
        Reload
      </Button>
    </EmptyState>
  );
}

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
                <Suspense fallback={<Loading />}>
                  <RepoViews view={view} />
                </Suspense>
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
  // The verdict is kept until the next one (adjusting state while rendering, as React's docs
  // describe).
  const [kept, setKept] = useState(false);
  const verdict = notOpened(kept, { data, error });
  if (verdict !== kept) setKept(verdict);
  if (verdict) {
    return (
      <RepoWelcome
        onOpen={openRepo}
        notOpenedRepo={repo}
        className="h-full min-h-0 overflow-y-auto p-4"
      />
    );
  }
  if (data === undefined && !error) return <Loading />;
  return children;
}

function Loading() {
  // It fades in late, so a quick first status (or views chunk) doesn't flash it.
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
