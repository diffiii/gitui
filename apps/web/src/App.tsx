import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { Suspense, use, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type AppConfig, getConfig } from "@/lib/api";
import { asksBeforeOpening } from "@/lib/asksBeforeOpening";
import { useConnection } from "@/lib/connection";
import { repoName } from "@/lib/format";
import { notOpened } from "@/lib/notOpened";
import { RepoProvider } from "@/lib/repo";
import { useStatus } from "@/lib/status";
import { openRepo, setView, useUrl } from "@/lib/url";
import type { View } from "@/lib/views";
import { AppHeader } from "./components/AppHeader";
import { PageOutdated } from "./components/PageOutdated";
import { ConfirmOpenRepo, RepoWelcome } from "./components/RepoPicker";
import { ViewTabBar } from "./components/ViewTabs";

type RepoViewsModule = typeof import("./components/RepoViews");
let repoViews: Promise<RepoViewsModule | null> | undefined;

/**
 * The repo's views (RepoViews.tsx says why they load on demand), loading them on the first call;
 * the same promise on every call. Null if they can't load: this page was deployed over since it
 * loaded, so the chunk is gone, and only a reload helps.
 */
function loadRepoViews(): Promise<RepoViewsModule | null> {
  repoViews ??= import("./components/RepoViews").catch((e: unknown) => {
    console.error(e);
    return null;
  });
  return repoViews;
}

/**
 * Repositories the user said yes to, or that gitui had opened, so the question isn't asked again
 * if the recent list later drops one.
 */
const trusted = new Set<string>();

export default function App() {
  const { repo: urlRepo, view } = useUrl();
  const { data: config, isLoading } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // `gitui <path>` passes the repo to the server; use it while the URL has none.
  const repo = urlRepo ?? config?.initialRepo ?? null;

  return (
    <TooltipProvider delayDuration={400}>
      <title>{repo ? `${repoName(repo)} · gitui` : "gitui"}</title>
      {isLoading ? null : repo === null ? (
        <RepoWelcome onOpen={openRepo} />
      ) : (
        <RepoGate repo={repo} view={view} config={config} />
      )}
      <Toaster
        position="bottom-right"
        offset={{ bottom: "var(--toaster-bottom)" }}
        mobileOffset={{ bottom: "var(--toaster-mobile-bottom)" }}
      />
    </TooltipProvider>
  );
}

/** Asks first for a repo that a link named and gitui hasn't opened; see `asksBeforeOpening`. */
function RepoGate({
  repo,
  view,
  config,
}: {
  repo: string;
  view: View;
  config: AppConfig | undefined;
}) {
  const connection = useConnection();
  if (!trusted.has(repo)) {
    if (asksBeforeOpening(config, repo, connection.kind)) {
      return (
        <ConfirmOpenRepo
          repo={repo}
          onOpen={(root) => {
            trusted.add(repo);
            trusted.add(root);
            openRepo(root);
          }}
          onCancel={() => setView(null, view)}
        />
      );
    }
    trusted.add(repo);
  }
  return <RepoScreen repo={repo} view={view} />;
}

function RepoScreen({ repo, view }: { repo: string; view: View }) {
  const onView = (v: View) => setView(repo, v);
  // The views' chunk loads alongside the repo's first status, not after it. It starts only here,
  // once the repo is allowed, so nothing loads while the question is asked.
  void loadRepoViews();
  return (
    <RepoProvider key={repo} repo={repo}>
      {/* viewport-fit=cover (index.html) lays the page under iOS's notch and home indicator. */}
      <div className="flex h-svh flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:pb-[env(safe-area-inset-bottom)]">
        <AppHeader view={view} onView={onView} onOpenRepo={openRepo} />
        <main className="min-h-0 flex-1">
          <OpenedRepo repo={repo} view={view} />
        </main>
        <ViewTabBar view={view} onView={onView} />
      </div>
    </RepoProvider>
  );
}

/**
 * The repo's views, unless this device may only use repositories opened on the computer and
 * `repo` isn't one (a link from elsewhere): then the picker, saying so. The views wait for the
 * repo's first status, so such a repo doesn't flash their errors first; the status keeps polling,
 * so the views come up once the repo is opened on the computer.
 */
function OpenedRepo({ repo, view }: { repo: string; view: View }) {
  const { data, error } = useStatus();
  // The verdict is kept until the next one (adjusting state while rendering, as React's docs
  // describe).
  const [kept, setKept] = useState(false);
  // What the views wait on while the status loads: it never settles, and this renders them again
  // once the status is in. Held here, so it goes with this repo's tree.
  const [statusWait] = useState(() => new Promise<never>(() => {}));
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
  return (
    <Suspense fallback={<Loading />}>
      <Views view={view} statusWait={data === undefined && !error ? statusWait : null} />
    </Suspense>
  );
}

/**
 * The views, once their chunk and the repo's first status are in. Both waits suspend, so one
 * fallback shows throughout, whichever of them ends last.
 */
function Views({ view, statusWait }: { view: View; statusWait: Promise<never> | null }) {
  const views = use(loadRepoViews());
  if (statusWait) use(statusWait);
  return views ? (
    <views.RepoViews view={view} />
  ) : (
    <PageOutdated className="h-full justify-center p-8" />
  );
}

function Loading() {
  // It fades in late, so a quick first status and chunk don't flash it.
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
