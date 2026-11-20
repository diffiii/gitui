import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="mb-1 rounded-xl border bg-muted/50 p-3 text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-xs break-all text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}
