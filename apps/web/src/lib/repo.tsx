import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { toast } from "sonner";
import { repoApi, type RepoApi } from "./api.ts";

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
 * A mutation that refreshes all of the repo's queries afterwards and toasts errors, and its
 * `success` message (or the one for its variables) when it succeeds. The toasts belong to the
 * mutation, not to one `mutate` call, so they show even if the component that called it remounts
 * when the queries refresh.
 */
export function useGitMutation<V>(
  fn: (api: RepoApi, vars: V) => Promise<unknown>,
  success?: string | ((vars: V) => string | undefined),
) {
  const { repo, api } = useRepo();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => fn(api, vars),
    onSuccess: (_, vars) => {
      const message = typeof success === "function" ? success(vars) : success;
      if (message) toast.success(message);
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: [repo] }),
  });
}
