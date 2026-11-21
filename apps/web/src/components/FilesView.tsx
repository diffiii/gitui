import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileCode, FileQuestion, FileX, FolderTree, Link } from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fileListStamp } from "@/lib/files";
import { formatBytes } from "@/lib/format";
import { useListChoice } from "@/lib/listChoice";
import { NARROW } from "@/lib/media";
import { pollInterval } from "@/lib/polling";
import { useRepo } from "@/lib/repo";
import { useStatus } from "@/lib/status";
import { useUrl } from "@/lib/url";
import { CodeFile } from "./DiffView";
import { EmptyState } from "./EmptyState";
import { FileTitle } from "./FileTitle";
import { FilterInput } from "./FilterInput";
import { ListDetail } from "./ListDetail";
import { PathTree } from "./PathTree";

/** The working copy's files, refetched when the status shows files added, deleted or renamed. */
function useWorkingFiles() {
  const { repo, api } = useRepo();
  const { data: status } = useStatus();
  const stamp = useMemo(() => status && fileListStamp(status), [status]);
  return useQuery({
    queryKey: [repo, "files", stamp],
    queryFn: api.files,
    enabled: stamp !== undefined,
    placeholderData: keepPreviousData,
    // Each stamp is its own entry, holding up to 50,000 paths: drop the old ones once unused.
    gcTime: 0,
  });
}

export function FilesView() {
  const { data, error } = useWorkingFiles();
  const [filter, setFilter] = useState("");
  const url = useUrl();
  const listed = useMemo(() => new Set(data?.paths), [data]);
  // A path from a link is taken on trust until the list loads; then it must be in it.
  const chosen = url.path !== null && (!data || listed.has(url.path)) ? url.path : null;
  const choice = useListChoice({ param: "path", breakpoint: NARROW, chosen, first: null });
  const { shown } = choice;

  return (
    <ListDetail
      choice={choice}
      listPanel={{ defaultSize: "30%", minSize: "260px" }}
      detailPanel={{ minSize: "400px" }}
      list={
        <>
          <div className="flex shrink-0 items-center border-b p-2">
            <FilterInput value={filter} onChange={setFilter} placeholder="Filter files" />
          </div>
          {data?.truncated && (
            <p className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
              Showing the first {data.paths.length.toLocaleString()} files.
            </p>
          )}
          <div className="min-h-0 flex-1 px-1 pb-1">
            {error ? (
              <p className="p-3 text-sm text-destructive">{error.message}</p>
            ) : (
              data && (
                <PathTree
                  paths={data.paths}
                  selected={shown}
                  onSelect={(path) => choice.choose({ path })}
                  collapsed
                  search={filter}
                />
              )
            )}
          </div>
        </>
      }
      detail={
        shown === null
          ? null
          : {
              content: <FileContents key={shown} path={shown} />,
              title: <FileTitle path={shown} />,
              label: shown,
              backLabel: "Back to files",
            }
      }
      empty={
        <EmptyState
          icon={FolderTree}
          title="No file selected"
          description="Choose a file to see what's in it now, uncommitted changes included."
        />
      }
    />
  );
}

/** A working-copy file's contents, highlighted, or why they aren't shown. Polled, like a diff. */
function FileContents({ path }: { path: string }) {
  const { repo, api } = useRepo();
  const { data, error } = useQuery({
    queryKey: [repo, "file", path],
    queryFn: (c) => api.file(path, c),
    refetchInterval: (q) =>
      pollInterval(q.state.data?.kind === "text" ? q.state.data.content.length : undefined),
  });

  if (error) return <div className="p-6 text-sm text-destructive">{error.message}</div>;
  if (!data) return null;
  switch (data.kind) {
    case "binary":
      return (
        <EmptyState
          icon={FileQuestion}
          title={`Binary file, ${formatBytes(data.size)}`}
          description={path}
        />
      );
    case "tooLarge":
      return (
        <EmptyState
          icon={FileX}
          title={`Too large to show, ${formatBytes(data.size)}`}
          description={path}
        />
      );
    case "symlink":
      return <EmptyState icon={Link} title="Symbolic link" description={data.target} />;
    case "text":
      if (!data.content) {
        return <EmptyState icon={FileCode} title="Empty file" description={path} />;
      }
      return (
        <ScrollArea className="h-full">
          <div className="p-3">
            <CodeFile name={path} contents={data.content} />
          </div>
        </ScrollArea>
      );
  }
}
