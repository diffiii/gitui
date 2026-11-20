import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Columns2,
  Download,
  EllipsisVertical,
  Laptop,
  type LucideIcon,
  Moon,
  RefreshCw,
  Rows2,
  Sun,
  Unplug,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setPairing, useConnection } from "@/lib/connection";
import { PALETTE_IDS, PALETTES } from "@/lib/palettes";
import { THEMES, useDiffStyle, usePalette, useTheme, type Theme } from "@/lib/prefs";
import { useRepo } from "@/lib/repo";
import { cn } from "@/lib/utils";
import { DisconnectButton } from "./ConnectionGate";

/** The header's controls after the views: remotes, diff style, theme and disconnect. */
export function HeaderActions({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <RemoteButtons />
      <div className="mx-1 h-5 w-px bg-border" />
      <DiffStyleToggle />
      <ThemeMenu />
      <DisconnectButton />
    </div>
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

/** HeaderActions as a menu, for narrow screens: remotes, theme, disconnect. */
export function MoreMenu() {
  const run = useRemoteAction();
  const connection = useConnection();
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
        {connection.kind === "paired" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPairing(null)}>
              <Unplug />
              Disconnect from port {connection.pairing.port}
            </DropdownMenuItem>
          </>
        )}
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
