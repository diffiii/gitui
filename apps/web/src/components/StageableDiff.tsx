import type { LinesAction, LineSelection } from "@gitui/shared";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { Minus, Plus, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { FileStatus } from "@/lib/api";
import { lineActions } from "@/lib/changes";
import { hunkEnd, hunkLabel, hunkLines, lineCount, rangeLines } from "@/lib/lineSelection";
import { useGitMutation } from "@/lib/repo";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffView, fileKey, useDiffOptions, useParsedPatch } from "./DiffView";

/** Which hunk an annotation's actions are for. */
interface HunkMeta {
  hunk: number;
}

const ICONS = { stage: Plus, unstage: Minus, discard: Undo2 };
const VERBS = { stage: "Stage", unstage: "Unstage", discard: "Discard" };

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

/**
 * A file's diff in the Changes view whose hunks and lines can be staged, unstaged or discarded
 * (`lineActions`): each hunk ends with its buttons, and a selection of lines (dragged on the line
 * numbers) gets a bar with them at the bottom. A diff that isn't one file with hunks shows as
 * usual. `base` is the diff's, from `/diff`: the server refuses lines of a diff that changed.
 */
export function StageableDiff({
  file,
  staged,
  diff,
  base,
}: {
  file: FileStatus;
  staged: boolean;
  diff: string;
  base: string;
}) {
  const { files } = useParsedPatch(diff);
  const parsed = files.length === 1 && files[0]!.hunks.length > 0 ? files[0]! : null;
  if (!parsed) return <DiffView raw={diff} className="p-3" />;
  // A new diff starts with nothing selected.
  return <StageableFile key={base} file={file} staged={staged} fileDiff={parsed} base={base} />;
}

function StageableFile({
  file,
  staged,
  fileDiff,
  base,
}: {
  file: FileStatus;
  staged: boolean;
  fileDiff: FileDiffMetadata;
  base: string;
}) {
  const diffOptions = useDiffOptions();
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [discarding, setDiscarding] = useState<LineSelection | null>(null);
  const actions = lineActions(file, staged);
  // A success changes the diff, so this remounts (keyed by base) before a `mutate` call's own
  // callbacks would run: the toast is the mutation's, and the new diff starts unselected.
  const mutation = useGitMutation(
    (api, v: { action: LinesAction; lines: LineSelection }) =>
      api.applyLines({ path: file.path, action: v.action, base, lines: v.lines }),
    (v) => (v.action === "discard" ? "Changes discarded" : undefined),
  );
  /** Does `action` to `sel`: the one way a hunk's, a selection's or a confirmed one goes. */
  const apply = (action: LinesAction, sel: LineSelection) =>
    // After a failure the diff may be the same, and this stays: close the dialog then.
    mutation.mutate({ action, lines: sel }, { onSettled: () => setDiscarding(null) });
  /** A button's action: a discard is asked about first. */
  const choose = (action: LinesAction, sel: LineSelection) =>
    action === "discard" ? setDiscarding(sel) : apply(action, sel);

  const options = useMemo(
    () => ({
      ...diffOptions,
      enableLineSelection: true,
      // Context lines alone aren't a selection: nothing to stage there.
      onLineSelected: (r: SelectedLineRange | null) =>
        setRange(r && lineCount(rangeLines(fileDiff, r, diffOptions.diffStyle)) > 0 ? r : null),
    }),
    [diffOptions, fileDiff],
  );
  const annotations = useMemo(
    () =>
      fileDiff.hunks.flatMap((h, hunk): DiffLineAnnotation<HunkMeta>[] => {
        const end = hunkEnd(h);
        return end ? [{ ...end, metadata: { hunk } }] : [];
      }),
    [fileDiff],
  );
  const selection = rangeLines(fileDiff, range, diffOptions.diffStyle);
  const selected = lineCount(selection);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div data-file={fileKey(fileDiff)} className="overflow-clip rounded-lg border bg-card">
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          selectedLines={range}
          lineAnnotations={annotations}
          renderAnnotation={(a) => (
            <ActionBar
              className="border-y bg-muted/40 px-2 py-1"
              label={hunkLabel(fileDiff.hunks[a.metadata.hunk]!)}
              actions={actions}
              noun="hunk"
              pending={mutation.isPending}
              onAction={(action) => choose(action, hunkLines(fileDiff, a.metadata.hunk))}
            />
          )}
        />
      </div>
      {selected > 0 && (
        <ActionBar
          className="sticky bottom-3 rounded-lg border bg-popover p-2 shadow-md"
          // The buttons say how many lines; the label is only for screen readers.
          label={`${lines(selected)} selected`}
          hideLabel
          actions={actions}
          noun={lines(selected)}
          pending={mutation.isPending}
          onAction={(action) => choose(action, selection)}
          onClear={() => setRange(null)}
        />
      )}
      <ConfirmDialog
        open={!!discarding}
        onClose={() => setDiscarding(null)}
        title="Discard these changes?"
        pending={mutation.isPending}
        description={
          <>
            This reverts {discarding ? lines(lineCount(discarding)) : "lines"} of unstaged changes
            in <code className="font-mono wrap-break-word text-foreground">{file.path}</code>. This
            can&apos;t be undone.
          </>
        }
        actions={[
          {
            label: "Discard",
            variant: "destructive",
            onSelect: () => {
              if (discarding) apply("discard", discarding);
            },
          },
        ]}
      />
    </div>
  );
}

/** The buttons for a hunk or a selection: one per action, and Clear for a selection. */
function ActionBar({
  className,
  label,
  hideLabel = false,
  actions,
  noun,
  pending,
  onAction,
  onClear,
}: {
  className: string;
  label: string;
  hideLabel?: boolean;
  actions: LinesAction[];
  noun: string;
  pending: boolean;
  onAction: (action: LinesAction) => void;
  onClear?: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn(
        // The UI's font, not the diff's, which an annotation would inherit.
        "flex flex-wrap items-center justify-end gap-1 font-sans",
        className,
      )}
    >
      {!hideLabel && (
        <span className="mr-auto truncate text-xs text-muted-foreground">{label}</span>
      )}
      {actions.map((action) => {
        const Icon = ICONS[action];
        return (
          <Button
            key={action}
            variant="ghost"
            size="xs"
            disabled={pending}
            className={cn("touch-target", action === "discard" && "text-destructive")}
            onClick={() => onAction(action)}
          >
            <Icon />
            {VERBS[action]} {noun}
          </Button>
        );
      })}
      {onClear && (
        <Button
          variant="ghost"
          size="xs"
          className="touch-target text-muted-foreground"
          onClick={onClear}
        >
          <X />
          Clear
        </Button>
      )}
    </div>
  );
}
