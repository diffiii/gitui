import { useQuery } from "@tanstack/react-query";
import { useRepo } from "./repo.tsx";

/**
 * The repo's branches, polled every 10 s; the header's branch switcher and the Branches view
 * share it.
 */
export function useBranches() {
  const { repo, api } = useRepo();
  return useQuery({ queryKey: [repo, "branches"], queryFn: api.branches, refetchInterval: 10000 });
}
