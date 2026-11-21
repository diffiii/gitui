import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitStatusEntry } from "@pierre/trees";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Copy,
  GitCommitHorizontal,
  History,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { usePanelRef } from "react-resizable-panels";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Commit } from "@/lib/api";
import { fullDate, initials, relativeTime } from "@/lib/format";
import { layoutGraph } from "@/lib/graph";
import { useListChoice } from "@/lib/listChoice";
import { COARSE, NARROW, useMediaQuery } from "@/lib/media";
import { useHistoryDetails } from "@/lib/prefs";
import { useGitMutation, useRepo } from "@/lib/repo";
import { select, useUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import { useWindowedRows } from "@/lib/windowing";
import { Age } from "./Age";
import { GraphCell, ROW_H, TOUCH_ROW_H } from "./CommitGraph";
import { CommitTitle } from "./CommitTitle";
import { DiffFiles, fileKey, useParsedPatch } from "./DiffView";
import { EmptyState } from "./EmptyState";
import { ListDetail } from "./ListDetail";
import { PathTree } from "./PathTree";
import { type ParsedRef, RefBadges } from "./RefBadges";
import { TruncatedNotice } from "./TruncatedNotice";

const PAGE = 300;

/**
 * Commit graph on the left, the URL's commit (or the newest) on the right. Remount (key) to reset
 * the paging.
 */
export function HistoryPane({
  gitRef,
  all,
  toolbar,
}: {
  gitRef?: string;
  all: boolean;
  /** Leading controls in the bar over the graph. */
  toolbar?: React.ReactNode;
}) {
  const { repo, api } = useRepo();
  const [limit, setLimit] = useState(PAGE);
  const { commit } = useUrl();
  const { data, error, isLoading, isFetching, isPlaceholderData } = useQuery({
    queryKey: [repo, "log", gitRef ?? null, all, limit],
    queryFn: (c) => api.log({ limit, all, ref: gitRef }, c),
    placeholderData: (prev) => prev,
    refetchInterval: 10000,
  });
  // Only `limit` changes the key within one HistoryPane (it is remounted for another ref or `all`),
  // so a placeholder means the next page is loading: the previous one is shown, shorter than
  // `limit`, and the footer with its spinner has to stay up until the new one arrives.
  const loadingMore = isPlaceholderData;
  const commits = useMemo(() => data?.commits ?? [], [data]);
  const choice = useListChoice({
    param: "commit",
    breakpoint: NARROW,
    chosen: commit,
    first: commits[0]?.hash ?? null,
  });
  const { stacked, shown } = choice;
  const details = usePanelRef();
  const [detailsPref, setDetailsPref] = useHistoryDetails();
  const closed = detailsPref === "closed";
  const openDetails = () => {
    const panel = details.current;
    if (!panel?.isCollapsed()) return;
    panel.expand();
    // With no remembered size (e.g. it started closed), expand() stops at the minimum width.
    if (panel.getSize().inPixels < 400) panel.resize("45%");
  };
  const toggleDetails = () => (closed ? openDetails() : details.current?.collapse());

  return (
    <ListDetail
      choice={choice}
      listPanel={{ defaultSize: closed ? "100%" : "55%", minSize: "320px" }}
      detailPanel={{
        panelRef: details,
        defaultSize: closed ? "0%" : "45%",
        minSize: "360px",
        collapsible: true,
        collapsedSize: "0%",
        onResize: (size) => setDetailsPref(size.asPercentage === 0 ? "closed" : "open"),
      }}
      list={
        <>
          {/* With no toolbar, a phone has nothing to show here: the details toggle is for panels. */}
          <div
            className={cn(
              "flex h-10 shrink-0 items-center gap-2 border-b px-3",
              !toolbar && "max-md:hidden",
            )}
          >
            {toolbar}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="touch-target ml-auto max-md:hidden"
                  onClick={toggleDetails}
                >
                  {closed ? <PanelRightOpen /> : <PanelRightClose />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {closed ? "Show commit details" : "Hide commit details"}
              </TooltipContent>
            </Tooltip>
          </div>
          {isLoading ? (
            <ListSkeleton />
          ) : error ? (
            <div className="p-6 text-sm text-destructive">{error.message}</div>
          ) : commits.length === 0 ? (
            <EmptyState icon={History} title="No commits yet" />
          ) : (
            <CommitList
              commits={commits}
              selected={shown}
              onSelect={(hash) => choice.choose({ commit: hash })}
              onOpen={(hash) => {
                choice.choose({ commit: hash });
                openDetails();
              }}
              footer={
                (commits.length >= limit || loadingMore) && (
                  <div className="p-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full pointer-coarse:h-10"
                      disabled={isFetching}
                      onClick={() => setLimit((l) => l + PAGE)}
                    >
                      {isFetching && <Loader2 className="animate-spin" />}
                      Load more
                    </Button>
                  </div>
                )
              }
            />
          )}
        </>
      }
      detail={
        shown === null
          ? null
          : {
              // Side by side, a collapsed panel shows nothing.
              content:
                closed && !stacked ? null : (
                  <CommitDetail
                    key={shown}
                    hash={shown}
                    refs={commits.find((c) => c.hash === shown)?.refs}
                    onSelect={(hash) => select({ commit: hash })}
                  />
                ),
              title: <span className="font-mono text-sm">{shown.slice(0, 7)}</span>,
              label: `Commit ${shown.slice(0, 7)}`,
              backLabel: "Back to commits",
            }
      }
      empty={<EmptyState icon={GitCommitHorizontal} title="Select a commit" />}
    />
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: 12 }, (_, i) => (
        <Skeleton key={i} className="h-5" style={{ width: `${90 - ((i * 37) % 40)}%` }} />
      ))}
    </div>
  );
}

function CommitList({
  commits,
  selected,
  onSelect,
  onOpen,
  footer,
}: {
  commits: Commit[];
  selected: string | null;
  onSelect: (hash: string) => void;
  onOpen: (hash: string) => void;
  footer?: React.ReactNode;
}) {
  const { rows, width } = useMemo(() => layoutGraph(commits), [commits]);
  const checkout = useGitMutation(
    (api, r: ParsedRef) => api.checkout(r.name, r.kind === "remote"),
    "Switched branch",
  );
  // Only the rows in (or near) the viewport are mounted; spacers keep the scroll height.
  const coarse = useMediaQuery(COARSE);
  const rowH = coarse ? TOUCH_ROW_H : ROW_H;
  const { viewportRef, start, end, before, after } = useWindowedRows(commits.length, rowH);
  return (
    <ScrollArea className="@container min-h-0 flex-1" viewportRef={viewportRef}>
      <ul className="py-1">
        {before > 0 && <li aria-hidden style={{ height: before }} />}
        {commits.slice(start, end).map((c, k) => (
          <li
            key={c.hash}
            // Focusable, so focus can return to the row when its detail closes.
            tabIndex={0}
            onClick={() => onSelect(c.hash)}
            onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && onSelect(c.hash)}
            onDoubleClick={() => onOpen(c.hash)}
            style={{ height: rowH }}
            className={cn(
              "flex cursor-default items-center gap-2 pr-3 text-sm select-none",
              selected === c.hash ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
            )}
          >
            <GraphCell row={rows[start + k]} hash={c.hash} width={width} height={rowH} />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <RefBadges
                refs={c.refs}
                // Under a finger, a tap meant for the row would switch branches.
                onCheckout={coarse ? undefined : (r) => !checkout.isPending && checkout.mutate(r)}
                // Leave the subject room.
                className="max-w-1/2 overflow-hidden"
              />
              <CommitTitle title={c.subject} />
            </span>
            <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground @lg:inline">
              {c.author}
            </span>
            <span className="hidden w-16 shrink-0 font-mono text-xs text-muted-foreground @md:inline">
              {c.hash.slice(0, 7)}
            </span>
            <span
              className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums max-md:w-auto"
              title={fullDate(c.date)}
            >
              <Age date={c.date} />
            </span>
          </li>
        ))}
        {after > 0 && <li aria-hidden style={{ height: after }} />}
      </ul>
      {footer}
    </ScrollArea>
  );
}

const CHANGE_STATUS: Record<FileDiffMetadata["type"], GitStatusEntry["status"]> = {
  change: "modified",
  new: "added",
  deleted: "deleted",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

function CommitDetail({
  hash,
  refs,
  onSelect,
}: {
  hash: string;
  /** The commit's refs from the log, which is kept fresh, unlike the details. */
  refs?: string[];
  onSelect: (hash: string) => void;
}) {
  const { repo, api } = useRepo();
  const { data, error } = useQuery({
    queryKey: [repo, "commit", hash],
    queryFn: (c) => api.showCommit(hash, c),
    staleTime: Infinity,
  });
  const patch = useParsedPatch(data?.patch ?? "");
  const { files } = patch;
  const paths = useMemo(() => files.map(fileKey), [files]);
  const gitStatus = useMemo(
    () => files.map((f) => ({ path: fileKey(f), status: CHANGE_STATUS[f.type] })),
    [files],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  if (error) return <div className="p-6 text-sm text-destructive">{error.message}</div>;
  if (!data) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const additions = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.additionLines, 0), 0);
  const deletions = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.deletionLines, 0), 0);

  return (
    <ScrollArea className="h-full" viewportRef={scroller}>
      <div className="flex flex-col gap-4 p-4">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <RefBadges refs={refs ?? data.refs} className="shrink flex-wrap" />
          </div>
          <h2 className="text-base leading-snug font-semibold [&_.truncate]:whitespace-normal">
            <CommitTitle title={data.subject} />
          </h2>
          {data.body && (
            <pre className="font-sans text-sm whitespace-pre-wrap text-muted-foreground">
              {data.body}
            </pre>
          )}
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              {initials(data.author)}
            </div>
            <div className="min-w-0 text-sm">
              <div className="truncate">
                <span className="font-medium">{data.author}</span>{" "}
                <span className="text-muted-foreground">&lt;{data.email}&gt;</span>
              </div>
              <div className="text-xs text-muted-foreground" title={fullDate(data.date)}>
                {fullDate(data.date)} · {relativeTime(data.date)}
                {data.committer !== data.author && <> · committed by {data.committer}</>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              commit <CopyHash hash={data.hash} />
            </span>
            {data.parents.length > 0 && (
              <span className="flex items-center gap-1">
                {data.parents.length > 1 ? "parents" : "parent"}
                {data.parents.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onSelect(p)}
                    className="touch-target rounded px-1 font-mono text-foreground hover:bg-accent"
                  >
                    {p.slice(0, 7)}
                  </button>
                ))}
              </span>
            )}
          </div>
        </header>

        {data.truncated && <TruncatedNotice empty={files.length === 0} />}

        {files.length > 0 && (
          <section className="rounded-lg border">
            <div className="flex h-8 items-center gap-2 border-b px-3 text-xs">
              <span className="font-medium">
                {files.length}
                {data.truncated && "+"} file{files.length > 1 || data.truncated ? "s" : ""} changed
              </span>
              <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
              <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
            </div>
            <div style={{ height: Math.min(paths.length * 26 + 40, 260) }} className="p-1">
              <PathTree
                key={hash}
                paths={paths}
                gitStatus={gitStatus}
                selected={activeFile}
                onSelect={(path) => {
                  setActiveFile(path);
                  scroller.current
                    ?.querySelector(`[data-file="${CSS.escape(path)}"]`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" });
                }}
              />
            </div>
          </section>
        )}

        <DiffFiles patch={patch} truncated={data.truncated} />
      </div>
    </ScrollArea>
  );
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="touch-target inline-flex items-center gap-1 rounded px-1 font-mono text-foreground hover:bg-accent"
          onClick={() => {
            void navigator.clipboard.writeText(hash);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {hash.slice(0, 10)}
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>Copy full hash</TooltipContent>
    </Tooltip>
  );
}
