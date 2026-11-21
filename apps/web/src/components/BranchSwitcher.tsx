import { ArrowDown, ArrowUp, ChevronsUpDown, Cloud, GitBranch, GitBranchPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Branch, Status } from "@/lib/api";
import { useBranches } from "@/lib/branches";
import { useGitMutation } from "@/lib/repo";
import { cn } from "@/lib/utils";
import { Age } from "./Age";

/** Header control showing the current branch; opens a searchable list to switch or create. */
export function BranchSwitcher({ status }: { status: Status }) {
  const { head, operation } = status;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data } = useBranches();

  const { local, remote } = useMemo(() => {
    const all = data?.branches ?? [];
    const local = all.filter((b) => !b.remote);
    // Remote branches already tracked by a local branch are reachable through that branch.
    const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
    return { local, remote: all.filter((b) => b.remote && !tracked.has(b.name)) };
  }, [data]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const checkout = useGitMutation((api, b: Branch) => api.checkout(b.name, b.remote));
  const create = useGitMutation((api, name: string) => api.createBranch(name));

  const name = query.trim();
  const canCreate = name.length > 0 && !/\s/.test(name) && !local.some((b) => b.name === name);
  const busy = checkout.isPending || create.isPending;

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="touch-target gap-1.5 bg-muted/40 font-medium max-md:min-w-0 max-md:shrink"
          disabled={busy}
        >
          <GitBranch className="text-muted-foreground" />
          <span className="max-w-56 truncate">
            {head.branch ?? `detached @ ${head.oid?.slice(0, 7) ?? "?"}`}
          </span>
          {head.upstream && (head.ahead > 0 || head.behind > 0) && (
            <span className="flex items-center gap-1 font-normal text-muted-foreground tabular-nums">
              {head.ahead > 0 && (
                <span className="flex items-center">
                  <ArrowUp className="size-3" />
                  {head.ahead}
                </span>
              )}
              {head.behind > 0 && (
                <span className="flex items-center">
                  <ArrowDown className="size-3" />
                  {head.behind}
                </span>
              )}
            </span>
          )}
          {operation && (
            <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-300">
              {operation} in progress
            </span>
          )}
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-0" align="start">
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Switch or create a branch…"
          />
          <CommandList className="max-h-96">
            {!canCreate && <CommandEmpty>No branches found</CommandEmpty>}
            {canCreate && (
              <>
                <CommandGroup forceMount>
                  <CommandItem
                    forceMount
                    value={`create:${name}`}
                    onSelect={() => create.mutate(name, { onSuccess: close })}
                  >
                    <GitBranchPlus />
                    <span className="truncate">
                      Create branch <span className="font-mono font-medium">{name}</span>
                      {head.branch && (
                        <span className="text-muted-foreground"> from {head.branch}</span>
                      )}
                    </span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator alwaysRender />
              </>
            )}
            <CommandGroup heading="Local">
              {local.map((b) => (
                <BranchItem
                  key={b.ref}
                  branch={b}
                  onSelect={() => (b.current ? close() : checkout.mutate(b, { onSuccess: close }))}
                />
              ))}
            </CommandGroup>
            {remote.length > 0 && (
              <CommandGroup heading="Remote">
                {remote.map((b) => (
                  <BranchItem
                    key={b.ref}
                    branch={b}
                    onSelect={() => checkout.mutate(b, { onSuccess: close })}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function BranchItem({ branch: b, onSelect }: { branch: Branch; onSelect: () => void }) {
  const Icon = b.remote ? Cloud : GitBranch;
  return (
    <CommandItem value={b.name} onSelect={onSelect} data-checked={b.current} className="gap-2">
      <Icon className={cn(b.current ? "text-emerald-500" : "text-muted-foreground")} />
      <span className={cn("min-w-0 flex-1 truncate", b.current && "font-semibold")}>{b.name}</span>
      {(b.ahead > 0 || b.behind > 0) && (
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
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
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground max-md:w-auto">
        <Age date={b.date} />
      </span>
    </CommandItem>
  );
}
