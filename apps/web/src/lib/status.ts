import { useQuery } from "@tanstack/react-query";
import { useRepo } from "./repo.tsx";

/** The repo's status, polled every 3 s so edits made outside show up. */
export function useStatus() {
  const { repo, api } = useRepo();
  return useQuery({
    queryKey: [repo, "status"],
    queryFn: api.status,
    refetchInterval: 3000,
  });
}
