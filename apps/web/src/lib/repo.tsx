import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { toast } from "sonner";
import { repoApi, type RepoApi } from "./api.ts";
import { refreshedByMutations } from "./polling.ts";

interface RepoCtx {
  repo: string;
  api: RepoApi;
}

const Ctx = createContext<RepoCtx | null>(null);

export function RepoProvider({ repo, children }: { repo: string; children: React.ReactNode }) {
  const value = useMemo(() => ({ repo, api: repoApi(repo) }), [repo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRepo() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRepo outside RepoProvider");
  return v;
}

/**
 * A mutation that refreshes the repo's queries afterwards and toasts errors. It leaves loaded
 * commit details alone: a commit's hash fixes them, and their refs come from the log, which it
 * refreshes (refreshedByMutations).
 */
export function useGitMutation<V>(
  fn: (api: RepoApi, vars: V) => Promise<unknown>,
  success?: string,
) {
  const { repo, api } = useRepo();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => fn(api, vars),
    onSuccess: () => {
      if (success) toast.success(success);
    },
    onError: (e) => toast.error(e.message),
    onSettled: () =>
      qc.invalidateQueries({
        queryKey: [repo],
        predicate: (q) => refreshedByMutations(q.queryKey, q.state.data !== undefined),
      }),
  });
}
