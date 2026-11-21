import { cn } from "@/lib/utils";

/**
 * Banner for output the server cut off at its output cap (`MAX_OUTPUT` in server/git.ts): a patch
 * by default, or what `children` says.
 */
export function TruncatedNotice({
  empty = false,
  className,
  children,
}: {
  empty?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      {children ??
        (empty
          ? "Diff is larger than 8 MB and can't be shown"
          : "Diff is larger than 8 MB — showing only the first part")}
    </div>
  );
}
