import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, FolderGit2, FolderOpen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CenteredScreen } from "@/components/CenteredScreen";
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
    <CenteredScreen
      icon={FolderGit2}
      title="Open a repository"
      description="Paste a path to any folder inside a git repository, or pick a recent one."
    >
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
    </CenteredScreen>
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
        <Button
          variant="ghost"
          size="sm"
          className="touch-target gap-2 px-2 font-semibold max-md:min-w-0 max-md:shrink"
        >
          <FolderGit2 className="text-muted-foreground" />
          <span className="truncate">{basename(repo)}</span>
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
