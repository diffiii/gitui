import { ChevronLeft } from "lucide-react";
import type { PanelProps } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useMediaQuery } from "@/lib/media";

export interface Detail {
  content: React.ReactNode;
  /** The bar over the detail when it covers the list. */
  title: React.ReactNode;
  backLabel: string;
  onBack: () => void;
  actions?: React.ReactNode;
}

/**
 * A list with the chosen item's detail: side by side in resizable panels, or while `breakpoint`
 * (a media query) matches, stacked, with the detail covering the list under a bar that goes back.
 * The list stays mounted under it, so going back finds it as it was (scroll, expanded folders).
 */
export function ListDetail({
  breakpoint,
  list,
  detail,
  empty,
  listPanel,
  detailPanel,
  detailCollapsed = false,
  children,
}: {
  breakpoint: string;
  /** The list pane's content, laid out as a column. */
  list: React.ReactNode;
  /** Null when nothing is chosen (see `useListChoice`). */
  detail: Detail | null;
  /** Side by side, in the detail panel when there is no detail. */
  empty?: React.ReactNode;
  listPanel: PanelProps;
  detailPanel: PanelProps;
  /** Side by side, the detail panel is collapsed: render nothing in it. */
  detailCollapsed?: boolean;
  /** Rendered in either layout, e.g. the view's dialogs. */
  children?: React.ReactNode;
}) {
  const stacked = useMediaQuery(breakpoint);

  if (stacked) {
    return (
      <div className="relative h-full">
        <div className="flex h-full flex-col" inert={!!detail}>
          {list}
        </div>
        {detail && (
          <div className="absolute inset-0 flex flex-col bg-background">
            <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
              <Button
                variant="ghost"
                size="icon-lg"
                className="touch-target -ml-1"
                aria-label={detail.backLabel}
                onClick={detail.onBack}
              >
                <ChevronLeft className="size-5" />
              </Button>
              <div className="min-w-0 flex-1">{detail.title}</div>
              {detail.actions}
            </div>
            <div className="min-h-0 flex-1">{detail.content}</div>
          </div>
        )}
        {children}
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel {...listPanel} className="flex flex-col">
        {list}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel {...detailPanel}>
        {detailCollapsed ? null : detail ? detail.content : empty}
      </ResizablePanel>
      {children}
    </ResizablePanelGroup>
  );
}
