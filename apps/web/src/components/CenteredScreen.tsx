import { cn } from "cn";
import type { LucideIcon } from "lucide-react";

/** Full-page screen with a centred heading above its content, shown in place of the app. */
export function CenteredScreen({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // At least 1rem from each edge, and clear of the notch and home indicator (viewport-fit=cover).
    <div
      className={cn(
        "flex min-h-svh items-center justify-center bg-background pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]",
        className,
      )}
    >
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl border bg-muted/50 p-3">
            <Icon className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
