import { FileDiff, GitBranch, History, type LucideIcon } from "lucide-react";

/** The app's views, in tab order; the first is the default. */
export const VIEWS = [
  { view: "changes", label: "Changes", icon: FileDiff },
  { view: "history", label: "History", icon: History },
  { view: "branches", label: "Branches", icon: GitBranch },
] as const satisfies readonly { view: string; label: string; icon: LucideIcon }[];

export type View = (typeof VIEWS)[number]["view"];

export const isView = (v: string | null): v is View => VIEWS.some((t) => t.view === v);
