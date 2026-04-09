import { memo, useCallback } from 'react';

import { AnimatedDialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds/Dialog';
import { Button } from '@/renderer/ds/Button';

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export const ConfirmDialog = memo(
  ({
    open,
    onClose,
    onConfirm,
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  }: ConfirmDialogProps) => {
    const handleConfirm = useCallback(() => {
      onConfirm();
      onClose();
    }, [onConfirm, onClose]);

    return (
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>{title}</DialogHeader>
          {description && (
            <DialogBody>
              <p className="text-sm sm:text-xs text-fg-muted">{description}</p>
            </DialogBody>
          )}
          <DialogFooter className="gap-2 flex-col-reverse sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} className="justify-center sm:w-auto">
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'primary'}
              onClick={handleConfirm}
              className="justify-center sm:w-auto"
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
ConfirmDialog.displayName = 'ConfirmDialog';
