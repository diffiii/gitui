import type { ContextMenuItem, ContextMenuOpenContext, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { COARSE, useMediaQuery } from "@/lib/media";
import { useTheme } from "@/lib/prefs";
import { cn } from "@/lib/utils";

export interface TreeAction {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  destructive?: boolean;
  onSelect: (item: ContextMenuItem) => void;
}

interface PathTreeProps {
  paths: string[];
  gitStatus?: GitStatusEntry[];
  selected?: string | null;
  onSelect?: (path: string) => void;
  /** Row actions shown in the context menu (right-click or the row button). */
  actions?: (item: ContextMenuItem) => TreeAction[];
  className?: string;
}

/** A Pierre file tree kept in sync with a changing list of paths. */
export function PathTree(props: PathTreeProps) {
  const coarse = useMediaQuery(COARSE);
  // The tree reads these options only when it's created, so a change makes a new one.
  return <FileTreeView key={String(coarse)} {...props} coarse={coarse} />;
}

function FileTreeView({
  paths,
  gitStatus,
  selected,
  onSelect,
  actions,
  className,
  coarse,
}: PathTreeProps & { coarse: boolean }) {
  const { resolved } = useTheme();
  const onSelectRef = useRef(onSelect);
  const files = useRef(new Set(paths));
  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
    files.current = new Set(paths);
  });

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    // Taller rows under a finger.
    density: coarse ? "relaxed" : "compact",
    initialSelectedPaths: selected ? [selected] : [],
    composition: actions
      ? {
          contextMenu: {
            enabled: true,
            triggerMode: "both",
            // The row button shows on hover; under a finger, which doesn't hover, every row has it.
            buttonVisibility: coarse ? "always" : "when-needed",
          },
        }
      : undefined,
    onSelectionChange: (sel) => {
      const path = sel[sel.length - 1];
      if (path && files.current.has(path)) onSelectRef.current?.(path);
    },
  });

  const pathsKey = paths.join("\0");
  const prevKey = useRef(pathsKey);
  useEffect(() => {
    if (prevKey.current === pathsKey) return;
    prevKey.current = pathsKey;
    model.resetPaths(paths, { initialExpandedPaths: dirsOf(paths) });
  }, [model, pathsKey, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Mirror external selection into the tree.
  useEffect(() => {
    for (const p of model.getSelectedPaths()) if (p !== selected) model.getItem(p)?.deselect();
    if (selected && files.current.has(selected)) {
      const item = model.getItem(selected);
      if (item && !item.isSelected()) item.select();
    }
  }, [model, selected, pathsKey]);

  return (
    <FileTree
      model={model}
      className={cn("block h-full", className)}
      style={
        {
          colorScheme: resolved,
          "--trees-bg-override": "transparent",
          "--trees-font-family-override": "var(--font-sans)",
          "--trees-font-size-override": "13px",
          "--trees-selected-bg-override": "var(--accent)",
          "--trees-selected-fg-override": "var(--accent-foreground)",
          "--trees-border-color-override": "var(--border)",
          "--trees-fg-override": "var(--foreground)",
          "--trees-fg-muted-override": "var(--muted-foreground)",
        } as React.CSSProperties
      }
      renderContextMenu={
        actions
          ? (item, ctx) => <TreeMenu items={actions(item)} item={item} ctx={ctx} />
          : undefined
      }
    />
  );
}

function dirsOf(paths: string[]) {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  return [...dirs];
}

function TreeMenu({
  items,
  item,
  ctx,
}: {
  items: TreeAction[];
  item: ContextMenuItem;
  ctx: ContextMenuOpenContext;
}) {
  if (!items.length) return null;
  return (
    <div className="min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
      {items.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => {
            ctx.close();
            a.onSelect(item);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:py-2.5",
            a.destructive && "text-destructive",
          )}
        >
          {a.icon && <a.icon className="size-4" />}
          {a.label}
        </button>
      ))}
    </div>
  );
}
