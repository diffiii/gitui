import { useRepo } from "@/lib/repo";
import type { View } from "@/lib/views";
import { BranchSwitcher } from "./BranchSwitcher";
import { useStatus } from "./ChangesView";
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

  // Narrow screens keep the pickers here, and move the views to ViewTabBar and the actions to
  // MoreMenu.
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <RepoSwitcher repo={repo} onOpen={onOpenRepo} />
      {status && <BranchSwitcher status={status} />}
      <ViewTabs view={view} onView={onView} className="mx-auto max-md:hidden" />
      <HeaderActions className="max-md:hidden" />
      <MoreMenu />
    </header>
  );
}
