import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAGE_OUTDATED } from "@/lib/nearby/errors";
import { cn } from "@/lib/utils";

/** Reloads the page: all that helps once it is out of date. */
export const ReloadButton = (
  props: Pick<React.ComponentProps<typeof Button>, "size" | "variant">,
) => (
  <Button {...props} onClick={() => location.reload()}>
    <RotateCw />
    Reload
  </Button>
);

/**
 * What a page shows where code it loads on demand would be, when that code can't load: the page
 * was deployed over since it loaded, so the chunk is gone.
 */
export function PageOutdated({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      <p>{PAGE_OUTDATED}</p>
      <ReloadButton variant="outline" />
    </div>
  );
}
