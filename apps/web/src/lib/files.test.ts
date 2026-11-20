import { expect, test } from "bun:test";
import type { Status } from "./api.ts";
import { fileListStamp } from "./files.ts";

const status = (oid: string | null, files: Status["files"]): Status => ({
  head: { branch: "main", oid, upstream: null, ahead: 0, behind: 0 },
  files,
  operation: null,
});

test("fileListStamp follows HEAD and the changed paths", () => {
  const base = status("abc", [{ path: "a.ts", x: ".", y: "M" }]);
  const stamp = fileListStamp(base);
  expect(fileListStamp(status("abc", [{ path: "a.ts", x: ".", y: "M" }]))).toBe(stamp);
  expect(fileListStamp(status("def", base.files))).not.toBe(stamp);
  expect(fileListStamp(status("abc", []))).not.toBe(stamp);
  expect(
    fileListStamp(
      status("abc", [...base.files, { path: "new.ts", x: ".", y: "?", untracked: true }]),
    ),
  ).not.toBe(stamp);
  expect(fileListStamp(status("abc", [{ path: "a.ts", x: ".", y: "D" }]))).not.toBe(stamp);
  expect(fileListStamp(status(null, []))).toBe(fileListStamp(status(null, [])));
});
