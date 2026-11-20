import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Columns2, Laptop, Moon, RefreshCw, Rows2, Sun, Upload, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDiffStyle, useTheme, type Theme } from "@/lib/prefs";
import { useRepo } from "@/lib/repo";
import { useStatus } from "./ChangesView";
import { BranchSwitcher } from "./BranchSwitcher";
import { RepoSwitcher } from "./RepoPicker";

export type View = "changes" | "history" | "branches";

export function AppHeader({
  view,
  onView,
  onOpenRepo,
}: {
  view: View;
  onView: (v: View) => void;
  onOpenRepo: (root: string) => void;
}) {
  const { repo } = useRepo();
  const { data: status } = useStatus();
  const changes = status?.files.length ?? 0;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <RepoSwitcher repo={repo} onOpen={onOpenRepo} />
      {status && <BranchSwitcher status={status} />}

      <Tabs value={view} onValueChange={(v) => onView(v as View)} className="mx-auto">
        <TabsList>
          <TabsTrigger value="changes" className="gap-1.5 px-3">
            Changes
            {changes > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
                {changes}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="px-3">
            History
          </TabsTrigger>
          <TabsTrigger value="branches" className="px-3">
            Branches
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex items-center gap-1">
        <RemoteButtons />
        <div className="mx-1 h-5 w-px bg-border" />
        <DiffStyleToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}

function RemoteButtons() {
  const { repo, api } = useRepo();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (action: "fetch" | "pull" | "push") => {
      const p = api.remote(action);
      toast.promise(p, {
        loading: `${action[0].toUpperCase()}${action.slice(1)}ing…`,
        success: `${action[0].toUpperCase()}${action.slice(1)} complete`,
        error: (e: Error) => e.message,
      });
      return p;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [repo] }),
  });
  const items = [
    { action: "fetch" as const, icon: RefreshCw, label: "Fetch all remotes" },
    { action: "pull" as const, icon: Download, label: "Pull (fast-forward only)" },
    { action: "push" as const, icon: Upload, label: "Push" },
  ];
  return (
    <>
      {items.map(({ action, icon: Icon, label }) => (
        <Tooltip key={action}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate(action)}
              className="gap-1.5 capitalize"
            >
              <Icon
                className={run.isPending && run.variables === action ? "animate-spin" : undefined}
              />
              <span className="hidden lg:inline">{action}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}

function DiffStyleToggle() {
  const [style, setStyle] = useDiffStyle();
  const split = style === "split";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setStyle(split ? "unified" : "split")}
        >
          {split ? <Columns2 /> : <Rows2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{split ? "Split diff" : "Unified diff"} — click to switch</TooltipContent>
    </Tooltip>
  );
}

const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = theme === "system" ? Laptop : theme === "dark" ? Moon : Sun;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={() => setTheme(NEXT_THEME[theme])}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="capitalize">Theme: {theme}</TooltipContent>
    </Tooltip>
  );
}
