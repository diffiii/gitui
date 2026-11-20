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
import { PALETTE_IDS, PALETTES } from "@/lib/palettes";
import { THEMES, useDiffStyle, usePalette, useTheme, type Theme } from "@/lib/prefs";
import { useDisconnect } from "@/lib/connection";
import type { RemoteAction } from "@/lib/remote";
import { cn } from "@/lib/utils";
import { DisconnectButton } from "./ConnectionGate";

/**
 * The header's controls after the views: remotes (unless `disabled`), diff style, theme and
 * disconnect.
 */
export function HeaderActions({
  remote,
  disabled = false,
  className,
}: {
  remote: RemoteAction;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <RemoteButtons run={remote} disabled={disabled} />
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

function RemoteButtons({ run, disabled }: { run: RemoteAction; disabled: boolean }) {
  return (
    <>
      {REMOTE_ACTIONS.map(({ action, icon: Icon, label }) => (
        <Tooltip key={action}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || run.isPending}
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

/** HeaderActions as a menu, for narrow screens: remotes (unless `disabled`), theme, disconnect. */
export function MoreMenu({
  remote: run,
  disabled = false,
}: {
  remote: RemoteAction;
  disabled?: boolean;
}) {
  const connected = useDisconnect();
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
            disabled={disabled || run.isPending}
            onSelect={() => run.mutate(action)}
          >
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <ThemeMenuItems />
        {connected && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={connected.disconnect}>
              <Unplug />
              <span className="truncate">Disconnect from {connected.target}</span>
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
