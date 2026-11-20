import type { ContextMenuItem, GitStatusEntry } from "@pierre/trees";
import { useQuery } from "@tanstack/react-query";
import { CheckCheck, FileDiff, Minus, Plus, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { FileStatus } from "@/lib/api";
import { type FileChoice, firstChange, resolveChoice, splitChanges } from "@/lib/changes";
import { splitPath } from "@/lib/format";
import { NARROW, useMediaQuery } from "@/lib/media";
import { useGitMutation, useRepo } from "@/lib/repo";
import { DetailScreen } from "./DetailScreen";
import { DiffView } from "./DiffView";
import { EmptyState } from "./EmptyState";
import { PathTree } from "./PathTree";
import { TruncatedNotice } from "./TruncatedNotice";

export function useStatus() {
  const { repo, api } = useRepo();
  return useQuery({
    queryKey: [repo, "status"],
    queryFn: api.status,
    refetchInterval: 3000,
  });
}

export function ChangesView() {
  const { data } = useStatus();
  const { staged, unstaged } = useMemo(() => splitChanges(data?.files ?? []), [data]);
  const [choice, setChoice] = useState<FileChoice | null>(null);
  const [discarding, setDiscarding] = useState<FileStatus[] | null>(null);
  const narrow = useMediaQuery(NARROW);

  // Keep the choice valid as files move between lists (e.g. after staging). Until a file is
  // chosen, wide screens show the first one and narrow ones show the list.
  const picked = useMemo(() => resolveChoice(choice, staged, unstaged), [choice, staged, unstaged]);
  const sel = picked ?? (narrow ? null : firstChange(staged, unstaged));

  const selected = sel
    ? (sel.staged ? staged : unstaged).find((f) => f.path === sel.path)
    : undefined;

  const list = (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <FileSection
          title="Staged"
          files={staged}
          staged
          selected={sel?.staged ? sel.path : null}
          onSelect={(path) => setChoice({ path, staged: true })}
          onDiscard={setDiscarding}
          empty="Nothing staged"
        />
        <FileSection
          title="Changes"
          files={unstaged}
          staged={false}
          selected={sel && !sel.staged ? sel.path : null}
          onSelect={(path) => setChoice({ path, staged: false })}
          onDiscard={setDiscarding}
          empty="Working tree clean"
        />
      </div>
      <CommitBox stagedCount={staged.length} />
    </>
  );
  const discardDialog = <DiscardDialog files={discarding} onClose={() => setDiscarding(null)} />;

  if (narrow) {
    return (
      <>
        {selected ? (
          <DetailScreen
            title={<FileTitle path={selected.path} />}
            backLabel="Back to changes"
            onBack={() => setChoice(null)}
            actions={<FileActions file={selected} staged={sel!.staged} onDiscard={setDiscarding} />}
          >
            <FileDiffPane file={selected} staged={sel!.staged} />
          </DetailScreen>
        ) : (
          <div className="flex h-full flex-col">{list}</div>
        )}
        {discardDialog}
      </>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="30%" minSize="260px" className="flex flex-col">
        {list}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize="400px">
        {selected ? (
          <FileDiffPane file={selected} staged={sel!.staged} />
        ) : (
          <EmptyState
            icon={CheckCheck}
            title="All clean"
            description="No changes in the working tree."
          />
        )}
      </ResizablePanel>
      {discardDialog}
    </ResizablePanelGroup>
  );
}

/** Stages `paths` from the unstaged list or unstages them from the staged one; all files without. */
function useToggleStaged() {
  const toggle = useGitMutation((api, v: { staged: boolean; paths?: string[] }) =>
    v.staged ? api.unstage(v.paths) : api.stage(v.paths),
  );
  return (staged: boolean, paths?: string[]) => toggle.mutate({ staged, paths });
}

function FileTitle({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-sm font-medium">{name}</span>
      {dir && <span className="truncate text-xs text-muted-foreground">{dir}</span>}
    </div>
  );
}

/** The open file's row actions, as buttons in its detail bar on narrow screens. */
function FileActions({
  file,
  staged,
  onDiscard,
}: {
  file: FileStatus;
  staged: boolean;
  onDiscard: (files: FileStatus[]) => void;
}) {
  const toggle = useToggleStaged();
  return (
    <>
      {!staged && (
        <Button
          variant="ghost"
          size="icon-lg"
          className="touch-target text-destructive"
          aria-label="Discard changes"
          onClick={() => onDiscard([file])}
        >
          <Undo2 />
        </Button>
      )}
      <Button variant="outline" onClick={() => toggle(staged, [file.path])}>
        {staged ? <Minus /> : <Plus />}
        {staged ? "Unstage" : "Stage"}
      </Button>
    </>
  );
}

function toGitStatus(f: FileStatus, staged: boolean): GitStatusEntry["status"] {
  if (f.untracked) return "untracked";
  const c = f.conflicted ? "M" : staged ? f.x : f.y;
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  if (c === "R" || c === "C") return "renamed";
  return "modified";
}

function FileSection({
  title,
  files,
  staged,
  selected,
  onSelect,
  onDiscard,
  empty,
}: {
  title: string;
  files: FileStatus[];
  staged: boolean;
  selected: string | null;
  onSelect: (path: string) => void;
  onDiscard: (files: FileStatus[]) => void;
  empty: string;
}) {
  const toggleStaged = useToggleStaged();
  const toggle = (paths?: string[]) => toggleStaged(staged, paths);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus = useMemo(
    () => files.map((f) => ({ path: f.path, status: toGitStatus(f, staged) })),
    [files, staged],
  );
  const under = (item: ContextMenuItem) =>
    item.kind === "file"
      ? files.filter((f) => f.path === item.path)
      : files.filter((f) => f.path.startsWith(item.path));

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b last:border-b-0">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
          {files.length}
        </span>
        {files.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="touch-target ml-auto text-muted-foreground"
            onClick={() => toggle()}
          >
            {staged ? <Minus /> : <Plus />}
            {staged ? "Unstage all" : "Stage all"}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground/70">{empty}</p>
      ) : (
        <div
          className="min-h-0 flex-1 px-1 pb-1"
          onDoubleClick={() => selected && toggle([selected])}
        >
          <PathTree
            paths={paths}
            gitStatus={gitStatus}
            selected={selected}
            onSelect={onSelect}
            actions={(item) => [
              {
                label: staged ? "Unstage" : "Stage",
                icon: staged ? Minus : Plus,
                onSelect: () => toggle(under(item).map((f) => f.path)),
              },
              ...(!staged
                ? [
                    {
                      label: "Discard changes",
                      icon: Undo2,
                      destructive: true,
                      onSelect: () => onDiscard(under(item)),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
    </section>
  );
}

function DiscardDialog({ files, onClose }: { files: FileStatus[] | null; onClose: () => void }) {
  const discard = useGitMutation(async (api, fs: FileStatus[]) => {
    for (const f of fs) await api.discard(f);
  }, "Changes discarded");
  const single = files?.length === 1 ? files[0] : null;
  return (
    <Dialog open={!!files} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard changes?</DialogTitle>
          <DialogDescription>
            {single ? (
              <>
                {single.untracked
                  ? "This deletes the untracked file "
                  : "This reverts unstaged changes in "}
                <code className="font-mono wrap-break-word text-foreground">{single.path}</code>.
              </>
            ) : (
              <>
                This reverts unstaged changes in {files?.length} files and deletes untracked ones.
              </>
            )}{" "}
            This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (files) discard.mutate(files);
              onClose();
            }}
          >
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileDiffPane({ file, staged }: { file: FileStatus; staged: boolean }) {
  const { repo, api } = useRepo();
  const untracked = !!file.untracked && !staged;
  const { data, error } = useQuery({
    queryKey: [repo, "diff", file.path, file.origPath, staged, untracked],
    queryFn: () => api.diff({ path: file.path, origPath: file.origPath, staged, untracked }),
    refetchInterval: 3000,
    placeholderData: (prev) => prev,
  });
  if (error) return <div className="p-6 text-sm text-destructive">{error.message}</div>;
  if (!data) return null;
  if (!data.diff.trim()) {
    return data.truncated ? (
      <EmptyState
        icon={FileDiff}
        title="Diff is too large to show"
        description={`${file.path} — larger than 8 MB`}
      />
    ) : (
      <EmptyState icon={FileDiff} title="No textual changes" description={file.path} />
    );
  }
  return (
    <ScrollArea className="h-full">
      {data.truncated && <TruncatedNotice className="mx-3 mt-3" />}
      <DiffView raw={data.diff} className="p-3" />
    </ScrollArea>
  );
}

function CommitBox({ stagedCount }: { stagedCount: number }) {
  const { api } = useRepo();
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const commit = useGitMutation(
    (api, v: { message: string; amend: boolean }) => api.commit(v.message, v.amend),
    amend ? "Commit amended" : "Committed",
  );
  const canCommit = (amend || (stagedCount > 0 && message.trim().length > 0)) && !commit.isPending;

  const submit = () => {
    if (!canCommit) return;
    commit.mutate(
      { message, amend },
      {
        onSuccess: () => {
          setMessage("");
          setAmend(false);
        },
      },
    );
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !message.trim()) setMessage((await api.lastMessage()).message.trim());
  };

  return (
    <div className="flex flex-col gap-2 border-t bg-muted/30 p-3">
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Commit message"
        className="min-h-20 resize-none bg-background font-mono"
      />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <Checkbox checked={amend} onCheckedChange={(v) => toggleAmend(v === true)} />
          Amend last commit
        </label>
        <Button className="touch-target ml-auto" size="sm" disabled={!canCommit} onClick={submit}>
          {amend
            ? "Amend"
            : `Commit${stagedCount ? ` ${stagedCount} file${stagedCount > 1 ? "s" : ""}` : ""}`}
          <kbd className="ml-1 hidden rounded bg-primary-foreground/15 px-1 font-sans text-[10px] sm:inline">
            ⌘↵
          </kbd>
        </Button>
      </div>
    </div>
  );
}
