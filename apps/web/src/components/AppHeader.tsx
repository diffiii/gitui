import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Columns2,
  Download,
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
import { useStatus } from "./ChangesView";
import { BranchSwitcher } from "./BranchSwitcher";
import { DisconnectButton } from "./ConnectionGate";
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
        <ThemeMenu />
        <DisconnectButton />
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

const MODES: Record<Theme, { label: string; icon: LucideIcon }> = {
  system: { label: "System", icon: Laptop },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const [palette, setPalette] = usePalette();
  const Icon = MODES[theme].icon;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
