import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConfirmAction {
  label: string;
  variant?: "destructive" | "outline";
  className?: string;
  onSelect: () => void;
  /** Whether this action's spinner shows while `pending`; it does unless this says otherwise. */
  busy?: boolean;
}

/**
 * A cancel button and the actions that confirm. While `pending` the dialog can't be closed, and
 * Cancel and every action are disabled, so a request can't be sent twice or abandoned half way.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  pending,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  pending: boolean;
  actions: ConfirmAction[];
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          {actions.map((a) => (
            <Button
              key={a.label}
              variant={a.variant}
              className={a.className}
              disabled={pending}
              onClick={a.onSelect}
            >
              {pending && (a.busy ?? true) && <Loader2 className="animate-spin" />}
              {a.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
