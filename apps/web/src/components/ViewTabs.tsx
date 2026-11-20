import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { isView, type View, VIEWS } from "@/lib/views";

/** The views as the header's tabs. */
export function ViewTabs({
  view,
  onView,
  className,
}: {
  view: View;
  onView: (v: View) => void;
  className?: string;
}) {
  return (
    <Tabs value={view} onValueChange={(v) => isView(v) && onView(v)} className={className}>
      <TabsList>
        {VIEWS.map(({ view: v, label }) => (
          <TabsTrigger key={v} value={v} className="gap-1.5 px-3">
            {label}
            {v === "changes" && <ChangeCount />}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The views as a tab bar at the bottom of narrow screens, in thumb reach. */
export function ViewTabBar({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <nav
      aria-label="Views"
      className="flex h-(--tab-bar-height) shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {VIEWS.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-current={view === v ? "page" : undefined}
          onClick={() => onView(v)}
          className={cn(
            "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
            view === v ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon className="size-5" />
          {label}
          {v === "changes" && <ChangeCount className="absolute top-1 left-1/2 ml-1" />}
        </button>
      ))}
    </nav>
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
      <span className="sr-only"> (</span>
      {changes}
      <span className="sr-only"> changed files)</span>
    </span>
  );
}
