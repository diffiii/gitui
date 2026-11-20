import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/api";
import { useApplyTheme } from "@/lib/prefs";
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

function writeUrl(repo: string | null, view: View, push: boolean) {
  const sp = new URLSearchParams();
  if (repo) sp.set("repo", repo);
  if (view !== "changes") sp.set("view", view);
  const url = `${location.pathname}${sp.size ? `?${sp}` : ""}`;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

export default function App() {
  useApplyTheme();
  const [{ repo: urlRepo, view }, setState] = useState(readUrl);
  const { data: config, isLoading } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // `gitui <path>` passes the repo to the server; adopt it if the URL has none.
  const repo = urlRepo ?? config?.initialRepo ?? null;

  useEffect(() => {
    const onPop = () => setState(readUrl());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!urlRepo && repo) writeUrl(repo, view, false);
  }, [urlRepo, repo, view]);

  useEffect(() => {
    document.title = repo ? `${repo.split("/").pop()} · gitui` : "gitui";
  }, [repo]);

  const openRepo = (root: string) => {
    setState({ repo: root, view: "changes" });
    writeUrl(root, "changes", true);
  };
  const setView = (v: View) => {
    setState((s) => ({ ...s, view: v }));
    writeUrl(repo, v, false);
  };

  return (
    <TooltipProvider delayDuration={400}>
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
