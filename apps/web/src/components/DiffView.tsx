import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import { PALETTES } from "@/lib/palettes";
import { useDiffStyle, usePalette, useTheme } from "@/lib/prefs";
import { cn } from "@/lib/utils";

export function useParsedPatch(raw: string) {
  return useMemo(() => {
    try {
      return parsePatchFiles(raw).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [raw]);
}

export const fileKey = (f: FileDiffMetadata) => f.name;

/** Renders every file of a unified git patch with Pierre Diffs. */
export function DiffView({ raw, className }: { raw: string; className?: string }) {
  const files = useParsedPatch(raw);
  return <DiffFiles files={files} className={className} />;
}

export function DiffFiles({ files, className }: { files: FileDiffMetadata[]; className?: string }) {
  const { resolved } = useTheme();
  const [palette] = usePalette();
  const [diffStyle] = useDiffStyle();
  const options = useMemo(
    () => ({
      theme: PALETTES[palette].diffs,
      themeType: resolved,
      diffStyle,
      overflow: "scroll" as const,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
    }),
    [resolved, palette, diffStyle],
  );

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
