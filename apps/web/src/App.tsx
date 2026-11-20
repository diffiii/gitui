import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import { RepoProvider } from "@/lib/repo";
import { AppHeader, type View } from "./components/AppHeader";
import { BranchesView } from "./components/BranchesView";
import { ChangesView } from "./components/ChangesView";
import { HistoryPane } from "./components/HistoryView";
import { RepoWelcome } from "./components/RepoPicker";
import { Button } from "./components/ui/button";

const VIEWS: View[] = ["changes", "history", "branches"];

function readUrl() {
  const sp = new URLSearchParams(location.search);
  const view = sp.get("view") as View | null;
  return { repo: sp.get("repo"), view: view && VIEWS.includes(view) ? view : "changes" };
}

// The URL is the source of truth for repo and view; components read it as an external store.
let urlState = readUrl();
const urlListeners = new Set<() => void>();
const syncUrl = () => {
  urlState = readUrl();
  urlListeners.forEach((l) => l());
};
addEventListener("popstate", syncUrl);
const subscribeUrl = (cb: () => void) => {
  urlListeners.add(cb);
  return () => urlListeners.delete(cb);
};

function writeUrl(repo: string | null, view: View, push: boolean) {
  const sp = new URLSearchParams();
  if (repo) sp.set("repo", repo);
  if (view !== "changes") sp.set("view", view);
  const url = `${location.pathname}${sp.size ? `?${sp}` : ""}`;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  syncUrl();
}

export default function App() {
  const { repo: urlRepo, view } = useSyncExternalStore(subscribeUrl, () => urlState);
  const { data: config, isLoading } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // `gitui <path>` passes the repo to the server; use it while the URL has none.
  const repo = urlRepo ?? config?.initialRepo ?? null;

  const openRepo = (root: string) => writeUrl(root, "changes", true);
  const setView = (v: View) => writeUrl(repo, v, false);

  return (
    <TooltipProvider delayDuration={400}>
      <title>{repo ? `${repo.split("/").pop()} · gitui` : "gitui"}</title>
      {repo ? (
        <RepoProvider key={repo} repo={repo}>
          <div className="flex h-svh flex-col bg-background">
            <AppHeader view={view} onView={setView} onOpenRepo={openRepo} />
            <main className="min-h-0 flex-1">
              {view === "changes" && <ChangesView />}
              {view === "history" && <HistoryView />}
              {view === "branches" && <BranchesView />}
            </main>
          </div>
        </RepoProvider>
      ) : isLoading ? null : (
        <RepoWelcome onOpen={openRepo} />
      )}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

function HistoryView() {
  const [all, setAll] = useState(false);
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
              className={all === o.v ? "bg-background shadow-sm" : "text-muted-foreground"}
              onClick={() => setAll(o.v)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      }
    />
  );
}
