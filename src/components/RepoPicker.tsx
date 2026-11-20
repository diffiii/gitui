import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, FolderGit2, FolderOpen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getConfig, openRepo } from "@/lib/api";

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function useOpenRepo(onOpen: (root: string) => void) {
  return useMutation({
    mutationFn: openRepo,
    onSuccess: (r) => onOpen(r.root),
    onError: (e) => toast.error(e.message),
  });
}

function tildify(p: string, home?: string) {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Full-page picker shown when no repository is selected. */
export function RepoWelcome({ onOpen }: { onOpen: (root: string) => void }) {
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const [path, setPath] = useState("");
  const open = useOpenRepo(onOpen);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl border bg-muted/50 p-3">
            <FolderGit2 className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Open a repository</h1>
          <p className="text-sm text-muted-foreground">
            Paste a path to any folder inside a git repository, or pick a recent one.
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) open.mutate(path.trim());
          }}
        >
          <Input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="~/code/my-project"
            className="font-mono"
          />
          <Button type="submit" disabled={!path.trim() || open.isPending}>
            Open
          </Button>
        </form>
        {!!config?.recent.length && (
          <div className="mt-8">
            <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Recent
            </h2>
            <ul className="overflow-hidden rounded-lg border">
              {config.recent.map((r) => (
                <li key={r} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => open.mutate(r)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{basename(r)}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {tildify(r, config.home)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** Header dropdown for switching repositories. */
export function RepoSwitcher({ repo, onOpen }: { repo: string; onOpen: (root: string) => void }) {
  const [openState, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const open = useOpenRepo((root) => {
    setOpen(false);
    onOpen(root);
  });
  const looksLikePath = /^[~/.]/.test(query);

  return (
    <Popover open={openState} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-2 font-semibold">
          <FolderGit2 className="text-muted-foreground" />
          {basename(repo)}
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search recent or type a path…"
          />
          <CommandList>
            <CommandEmpty>
              {looksLikePath ? "Press enter to open this path" : "No recent repositories"}
            </CommandEmpty>
            {looksLikePath && (
              <CommandGroup heading="Open path">
                <CommandItem value={`open:${query}`} onSelect={() => open.mutate(query)}>
                  <FolderOpen />
                  <span className="truncate font-mono text-xs">{query}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Recent">
              {config?.recent.map((r) => (
                <CommandItem key={r} value={r} onSelect={() => open.mutate(r)}>
                  <FolderGit2 />
                  <span className="min-w-0">
                    <span className="block truncate">{basename(r)}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {tildify(r, config.home)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
