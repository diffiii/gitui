import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Columns2,
  Download,
  EllipsisVertical,
  FileDiff,
  GitBranch,
  History,
  Laptop,
  type LucideIcon,
  Moon,
  RefreshCw,
  Rows2,
  Sun,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PALETTE_IDS, PALETTES } from "@/lib/palettes";
import { THEMES, useDiffStyle, usePalette, useTheme, type Theme } from "@/lib/prefs";
import { useRepo } from "@/lib/repo";
import { cn } from "@/lib/utils";
import { useStatus } from "./ChangesView";
import { BranchSwitcher } from "./BranchSwitcher";
import { DisconnectButton, DisconnectMenuItem } from "./ConnectionGate";
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

  // Narrow screens keep the pickers here, move the views to ViewTabBar and the rest to MoreMenu.
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <RepoSwitcher repo={repo} onOpen={onOpenRepo} />
      {status && <BranchSwitcher status={status} />}

      <Tabs value={view} onValueChange={(v) => onView(v as View)} className="mx-auto max-md:hidden">
        <TabsList>
          <TabsTrigger value="changes" className="gap-1.5 px-3">
            Changes
            <ChangeCount />
          </TabsTrigger>
          <TabsTrigger value="history" className="px-3">
            History
          </TabsTrigger>
          <TabsTrigger value="branches" className="px-3">
            Branches
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex items-center gap-1 max-md:hidden">
        <RemoteButtons />
        <div className="mx-1 h-5 w-px bg-border" />
        <DiffStyleToggle />
        <ThemeMenu />
        <DisconnectButton />
      </div>
      <MoreMenu />
    </header>
  );
}

/** How many files have changes, as a badge; nothing when there are none. */
function ChangeCount({ className }: { className?: string }) {
  const { data: status } = useStatus();
  const changes = status?.files.length ?? 0;
  if (!changes) return null;
  return (
    <span
      className={cn(
        "rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums",
        className,
      )}
    >
      {changes}
    </span>
  );
}

const VIEW_TABS: { view: View; label: string; icon: LucideIcon }[] = [
  { view: "changes", label: "Changes", icon: FileDiff },
  { view: "history", label: "History", icon: History },
  { view: "branches", label: "Branches", icon: GitBranch },
];

/** The views as a tab bar at the bottom of narrow screens, in thumb reach. */
export function ViewTabBar({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <nav
      aria-label="Views"
      className="flex h-(--tab-bar-height) shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {VIEW_TABS.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-current={view === v ? "page" : undefined}
          onClick={() => onView(v)}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
            view === v ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="relative">
            <Icon className="size-5" />
            {v === "changes" && <ChangeCount className="absolute -top-1.5 left-3.5" />}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}

const REMOTE_ACTIONS = [
  { action: "fetch" as const, icon: RefreshCw, label: "Fetch all remotes" },
  { action: "pull" as const, icon: Download, label: "Pull (fast-forward only)" },
  { action: "push" as const, icon: Upload, label: "Push" },
];

function useRemoteAction() {
  const { repo, api } = useRepo();
  const qc = useQueryClient();
  return useMutation({
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
}

function RemoteButtons() {
  const run = useRemoteAction();
  return (
    <>
      {REMOTE_ACTIONS.map(({ action, icon: Icon, label }) => (
        <Tooltip key={action}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate(action)}
              className="touch-target gap-1.5 capitalize"
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

/** Narrow screens' menu for the header controls that don't fit: remotes, theme, disconnect. */
function MoreMenu() {
  const run = useRemoteAction();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="More actions"
          className="touch-target ml-auto md:hidden"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {REMOTE_ACTIONS.map(({ action, icon: Icon, label }) => (
          <DropdownMenuItem
            key={action}
            disabled={run.isPending}
            onSelect={() => run.mutate(action)}
          >
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <ThemeMenuItems />
        <DisconnectMenuItem />
      </DropdownMenuContent>
    </DropdownMenu>
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
          aria-label="Diff style"
          className="touch-target"
          onClick={() => setStyle(split ? "unified" : "split")}
        >
          {split ? <Columns2 /> : <Rows2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{split ? "Split diff" : "Unified diff"} — click to switch</TooltipContent>
    </Tooltip>
  );
}

const MODES: Record<Theme, { label: string; icon: LucideIcon }> = {
  system: { label: "System", icon: Laptop },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

function ThemeMenu() {
  const { theme } = useTheme();
  const Icon = MODES[theme].icon;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Theme" className="touch-target">
              <Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  const [palette, setPalette] = usePalette();
  return (
    <>
      <DropdownMenuLabel>Mode</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
        {THEMES.map((t) => {
          const { label, icon: ModeIcon } = MODES[t];
          return (
            <DropdownMenuRadioItem key={t} value={t}>
              <ModeIcon />
              {label}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Colors</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={palette} onValueChange={setPalette}>
        {PALETTE_IDS.map((id) => (
          <DropdownMenuRadioItem key={id} value={id}>
            {/* data-palette scopes that palette's colors to the swatch (palettes.css). */}
            <span
              data-palette={id}
              className="size-3 rounded-full border border-border bg-primary"
            />
            {PALETTES[id].label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
