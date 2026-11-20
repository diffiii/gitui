import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Goes back from a pane shown in place of the list it was opened from. */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className="touch-target -ml-1"
      aria-label={label}
      onClick={onClick}
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}

/**
 * A two-pane view's detail on a narrow screen: it takes the list's place, under a bar that goes
 * back to the list and holds the detail's actions.
 */
export function DetailScreen({
  title,
  backLabel,
  onBack,
  actions,
  children,
}: {
  title: React.ReactNode;
  backLabel: string;
  onBack: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <BackButton label={backLabel} onClick={onBack} />
        <div className="min-w-0 flex-1">{title}</div>
        {actions}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
