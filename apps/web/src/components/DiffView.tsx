import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import { NARROW, useMediaQuery } from "@/lib/media";
import { PALETTES } from "@/lib/palettes";
import { useDiffStyle, usePalette, useTheme } from "@/lib/prefs";
import { cn } from "@/lib/utils";

/** The files of a raw patch; `failed` when it couldn't be parsed, which is not an empty diff. */
export function useParsedPatch(raw: string): { files: FileDiffMetadata[]; failed: boolean } {
  return useMemo(() => {
    try {
      return { files: parsePatchFiles(raw).flatMap((p) => p.files), failed: false };
    } catch {
      return { files: [], failed: true };
    }
  }, [raw]);
}

export const fileKey = (f: FileDiffMetadata) => f.name;

/** Renders every file of a unified git patch with Pierre Diffs. */
export function DiffView({ raw, className }: { raw: string; className?: string }) {
  const { files, failed } = useParsedPatch(raw);
  return <DiffFiles files={files} failed={failed} className={className} />;
}

/** The options Pierre Diffs' diffs and files share: the palette and light or dark, from the prefs. */
function useCodeOptions() {
  const { resolved } = useTheme();
  const [palette] = usePalette();
  return useMemo(
    () => ({ theme: PALETTES[palette].diffs, themeType: resolved, overflow: "scroll" as const }),
    [resolved, palette],
  );
}

export function DiffFiles({
  files,
  failed,
  className,
}: {
  files: FileDiffMetadata[];
  failed?: boolean;
  className?: string;
}) {
  const code = useCodeOptions();
  const [style] = useDiffStyle();
  // Split columns don't fit a phone screen.
  const diffStyle = useMediaQuery(NARROW) ? "unified" : style;
  const options = useMemo(
    () => ({
      ...code,
      diffStyle,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
    }),
    [code, diffStyle],
  );

  if (failed) {
    return (
      <div className={cn("p-6 text-sm text-destructive", className)}>
        This diff couldn&apos;t be parsed, so it can&apos;t be shown.
      </div>
    );
  }
  if (!files.length) {
    return (
      <div className={cn("p-6 text-sm text-muted-foreground", className)}>No textual changes.</div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {files.map((f, i) => (
        <div
          key={`${fileKey(f)}-${i}`}
          data-file={fileKey(f)}
          className="overflow-clip rounded-lg border bg-card"
        >
          <FileDiff fileDiff={f} options={options} />
        </div>
      ))}
    </div>
  );
}

/** A whole file, highlighted like a diff's lines, with line numbers. */
export function CodeFile({ name, contents }: { name: string; contents: string }) {
  const options = useCodeOptions();
  const file = useMemo(() => ({ name, contents }), [name, contents]);
  return (
    <div className="overflow-clip rounded-lg border bg-card">
      <File file={file} options={options} />
    </div>
  );
}
