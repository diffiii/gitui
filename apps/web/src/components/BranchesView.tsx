import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Cloud,
  GitBranch,
  GitBranchPlus,
  MoreHorizontal,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Branch } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useGitMutation, useRepo } from "@/lib/repo";
import { closeDetail, select, useUrl } from "@/lib/url";
import { useListChoice } from "@/lib/listChoice";
import { BELOW_LG } from "@/lib/media";
import { cn } from "@/lib/utils";
import { HistoryPane } from "./HistoryView";
import { ListDetail } from "./ListDetail";

export function useBranches() {
  const { repo, api } = useRepo();
  return useQuery({ queryKey: [repo, "branches"], queryFn: api.branches, refetchInterval: 10000 });
}

export function BranchesView() {
  const { data } = useBranches();
  const branches = useMemo(() => data?.branches ?? [], [data]);
  const [filter, setFilter] = useState("");
  const url = useUrl();
  const [creating, setCreating] = useState<{ from?: string } | null>(null);
  const [deleting, setDeleting] = useState<Branch | null>(null);

  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, filter]);
  const local = visible.filter((b) => !b.remote);
  const remote = visible.filter((b) => b.remote);
  // Keyed by full refname: a tag can share a branch's short name, and git prefers the tag.
  const chosen = branches.find((b) => b.ref === url.branch) ?? null;
  // Below lg the branch list and the branch's history (itself two panes) don't fit side by side.
  const { stacked, shown } = useListChoice(
    BELOW_LG,
    chosen,
    branches.find((b) => b.current) ?? branches[0] ?? null,
  );

  const checkout = useGitMutation(
    (api, b: Branch) => api.checkout(b.name, b.remote),
    "Switched branch",
  );

  const row = (b: Branch) => (
    <BranchRow
      key={b.ref}
      branch={b}
      active={shown?.ref === b.ref}
      onSelect={() =>
        select({ branch: b.ref, commit: null }, stacked && !shown ? "branch" : undefined)
      }
      onCheckout={() => checkout.mutate(b)}
      onCreate={() => setCreating({ from: b.name })}
      onDelete={() => setDeleting(b)}
    />
  );
  const branchName = (b: Branch) => (
    <span className="flex min-w-0 items-center gap-2">
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm font-medium">{b.name}</span>
    </span>
  );

  return (
    <ListDetail
      breakpoint={BELOW_LG}
      listPanel={{ defaultSize: "26%", minSize: "240px" }}
      detailPanel={{ minSize: "680px" }}
      list={
        <>
          <div className="flex shrink-0 items-center gap-2 border-b p-2">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter branches"
                className="h-8 pl-8 pointer-coarse:h-10"
              />
            </div>
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => setCreating({})}
              title="New branch"
              aria-label="New branch"
              className="touch-target"
            >
              <GitBranchPlus />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-2">
              <BranchGroup title="Local" count={local.length}>
                {local.map(row)}
              </BranchGroup>
              {remote.length > 0 && (
                <BranchGroup title="Remote" count={remote.length}>
                  {remote.map(row)}
                </BranchGroup>
              )}
            </div>
          </ScrollArea>
        </>
      }
      detail={
        shown && {
          // Stacked, the bar above names the branch.
          content: (
            <HistoryPane
              key={shown.ref}
              gitRef={shown.ref}
              all={false}
              toolbar={stacked ? undefined : branchName(shown)}
            />
          ),
          title: branchName(shown),
          backLabel: "Back to branches",
          onBack: () => closeDetail("branch"),
        }
      }
    >
      <CreateBranchDialog state={creating} onClose={() => setCreating(null)} />
      <DeleteBranchDialog branch={deleting} onClose={() => setDeleting(null)} />
    </ListDetail>
  );
}

function BranchGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
          {count}
        </span>
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function BranchRow({
  branch: b,
  active,
  onSelect,
  onCheckout,
  onCreate,
  onDelete,
}: {
  branch: Branch;
  active: boolean;
  onSelect: () => void;
  onCheckout: () => void;
  onCreate: () => void;
  onDelete: () => void;
}) {
  const Icon = b.remote ? Cloud : GitBranch;
  return (
    <li
      onClick={onSelect}
      onDoubleClick={() => !b.current && onCheckout()}
      className={cn(
        "group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 select-none",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <Icon
        className={cn("size-4 shrink-0", b.current ? "text-emerald-500" : "text-muted-foreground")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("truncate text-sm", b.current && "font-semibold")}>{b.name}</span>
          {b.current && (
            <span className="rounded bg-emerald-500/15 px-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              HEAD
            </span>
          )}
          {(b.ahead > 0 || b.behind > 0) && (
            <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
              {b.ahead > 0 && (
                <>
                  <ArrowUp className="size-3" />
                  {b.ahead}
                </>
              )}
              {b.behind > 0 && (
                <>
                  <ArrowDown className="size-3" />
                  {b.behind}
                </>
              )}
            </span>
          )}
          {b.gone && <span className="text-[11px] text-rose-500">gone</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {relativeTime(b.date)} · {b.subject}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="touch-target opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem disabled={b.current} onSelect={onCheckout}>
            <GitBranch /> Checkout
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCreate}>
            <GitBranchPlus /> New branch from here
          </DropdownMenuItem>
          {!b.remote && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={b.current} onSelect={onDelete}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function CreateBranchDialog({
  state,
  onClose,
}: {
  state: { from?: string } | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const create = useGitMutation(
    (api, v: { name: string; from?: string }) => api.createBranch(v.name, v.from),
    "Branch created",
  );
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), from: state?.from },
      {
        onSuccess: () => {
          setName("");
          onClose();
        },
      },
    );
  };
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>
              Creates and checks out a branch from{" "}
              <code className="font-mono text-foreground">{state?.from ?? "HEAD"}</code>.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="feature/my-branch"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteBranchDialog({ branch, onClose }: { branch: Branch | null; onClose: () => void }) {
  const del = useGitMutation(
    (api, v: { name: string; force: boolean }) => api.deleteBranch(v.name, v.force),
    "Branch deleted",
  );
  return (
    <Dialog open={!!branch} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete branch?</DialogTitle>
          <DialogDescription>
            Delete <code className="font-mono text-foreground">{branch?.name}</code>. Force delete
            also removes it if it has unmerged commits.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            onClick={() =>
              branch && del.mutate({ name: branch.name, force: true }, { onSuccess: onClose })
            }
          >
            Force delete
          </Button>
          <Button
            variant="destructive"
            onClick={() =>
              branch && del.mutate({ name: branch.name, force: false }, { onSuccess: onClose })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
