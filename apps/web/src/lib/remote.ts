import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRepo } from "./repo.tsx";

/** Fetch, pull or push, shared by the header's buttons and its menu so both show one run. */
export function useRemoteAction() {
  const { repo, api } = useRepo();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "fetch" | "pull" | "push") => {
      const p = api.remote(action);
      toast.promise(p, {
        loading: `${action[0].toUpperCase()}${action.slice(1)}ing…`,
        success: `${action[0].toUpperCase()}${action.slice(1)} complete`,
        error: (e: Error) => e.message,
      });
      return p;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [repo] }),
  });
}

export type RemoteAction = ReturnType<typeof useRemoteAction>;
