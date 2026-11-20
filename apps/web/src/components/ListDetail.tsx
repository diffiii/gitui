import { ChevronLeft } from "lucide-react";
import type { PanelProps } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { ListChoice } from "@/lib/listChoice";

export interface Detail {
  /** What the detail pane shows; null to show nothing in it. */
  content: React.ReactNode;
  /** The bar over the detail when it covers the list: its title, and its name for screen readers. */
  title: React.ReactNode;
  label: string;
  backLabel: string;
  actions?: React.ReactNode;
}

/**
 * A list with the chosen item's detail (`choice`, from `useListChoice`): side by side in resizable
 * panels, or stacked, with the detail covering the list under a bar that goes back. The list stays
 * mounted under it, so going back finds it as it was (scroll, expanded folders, focus).
 */
export function ListDetail({
  choice,
  list,
  detail,
  empty,
  listPanel,
  detailPanel,
}: {
  choice: Pick<ListChoice<unknown>, "stacked" | "close">;
  /** The list pane's content, laid out as a column. */
  list: React.ReactNode;
  /** Null when nothing is shown. */
  detail: Detail | null;
  /** Side by side, in the detail panel when there is no detail. */
  empty?: React.ReactNode;
  listPanel: PanelProps;
  detailPanel: PanelProps;
}) {
  if (choice.stacked) {
    return (
      <div className="relative h-full">
        <div className="flex h-full flex-col" inert={!!detail}>
          {list}
        </div>
        {detail && (
          <div
            role="region"
            aria-label={detail.label}
            className="absolute inset-0 flex flex-col bg-background"
          >
            <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
              <span hidden ref={returnFocusOnClose} />
              <Button
                autoFocus
                variant="ghost"
                size="icon-lg"
                className="touch-target -ml-1"
                aria-label={detail.backLabel}
                onClick={choice.close}
              >
                <ChevronLeft className="size-5" />
              </Button>
              <div className="min-w-0 flex-1">{detail.title}</div>
              {detail.actions}
            </div>
            <div className="min-h-0 flex-1">{detail.content}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel {...listPanel} className="flex flex-col">
        {list}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel {...detailPanel}>{detail ? detail.content : empty}</ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * Ref callback that notes what had focus when the detail opened, the list row that opened it, and
 * gives it back when the detail closes. It sits before the back button, so it runs before that
 * button's autoFocus takes the focus.
 */
function returnFocusOnClose(node: HTMLElement | null) {
  if (!node) return;
  let opener = document.activeElement;
  // A row in a shadow root (the file tree) is the focused element inside its host.
  while (opener?.shadowRoot?.activeElement) opener = opener.shadowRoot.activeElement;
  return () => {
    // The list is still inert while the detail unmounts, so focus it once that's committed.
    queueMicrotask(() => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    });
  };
}
