import { useRemoteAction } from "@/lib/remote";
import { useRepo } from "@/lib/repo";
import { useStatus } from "@/lib/status";
import type { View } from "@/lib/views";
import { BranchSwitcher } from "./BranchSwitcher";
import { HeaderActions, MoreMenu } from "./HeaderActions";
import { RepoSwitcher } from "./RepoPicker";
import { ViewTabs } from "./ViewTabs";

export function AppHeader({
  view,
  onView,
  onOpenRepo,
}: {
  view: View;
  onView: (v: View) => void;
  onOpenRepo: (root: string) => void;
}) {
  const { repo } = useRepo();
  const { data: status } = useStatus();
  const remote = useRemoteAction();

  // Narrow screens keep the pickers here, and move the views to ViewTabBar and the actions to
  // MoreMenu. Without a status (the repo isn't opened on the computer, say) the views and remotes
  // have nothing to work on.
  const ready = status !== undefined;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <RepoSwitcher repo={repo} onOpen={onOpenRepo} />
      {status && <BranchSwitcher status={status} />}
      <ViewTabs view={view} onView={onView} disabled={!ready} className="mx-auto max-md:hidden" />
      <HeaderActions remote={remote} disabled={!ready} className="max-md:hidden" />
      <MoreMenu remote={remote} disabled={!ready} />
    </header>
  );
}
