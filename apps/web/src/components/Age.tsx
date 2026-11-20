import { relativeTime, shortAge } from "@/lib/format";

/** How long ago `date` (unix seconds) was: "3 hr. ago", or "3h" on narrow screens. */
export function Age({ date }: { date: number }) {
  return (
    <>
      <span className="max-md:hidden">{relativeTime(date)}</span>
      <span className="md:hidden">{shortAge(date)}</span>
    </>
  );
}
