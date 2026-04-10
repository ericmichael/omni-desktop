import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/Button';
import { AnimatedDialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds/Dialog';

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
        <DialogContent>
          <DialogHeader>{title}</DialogHeader>
          {description && (
            <DialogBody>
              <p>{description}</p>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {cancelLabel}
            </Button>
            <Button variant={destructive ? 'destructive' : 'primary'} onClick={handleConfirm}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
ConfirmDialog.displayName = 'ConfirmDialog';
