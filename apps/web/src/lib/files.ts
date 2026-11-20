import type { Status } from "./api.ts";

/**
 * A short stamp of the status that the working copy's file list follows: HEAD and every changed
 * path with its state. Files added, deleted or renamed, and commits or checkouts, change it;
 * edits to an already changed file don't. Hashed (FNV-1a) to keep query keys small.
 */
export function fileListStamp(status: Status): string {
  let h = 0x811c9dc5;
  const add = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  };
  add(status.head.oid ?? "");
  for (const f of status.files) add(`\0${f.x}${f.y}${f.path}\0${f.origPath ?? ""}`);
  return (h >>> 0).toString(36);
}
