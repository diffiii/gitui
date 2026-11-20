import { splitPath } from "@/lib/format";

/** A file's name, with its folder under it: a detail pane's title. */
export function FileTitle({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-sm font-medium">{name}</span>
      {dir && <span className="truncate text-xs text-muted-foreground">{dir}</span>}
    </div>
  );
}
