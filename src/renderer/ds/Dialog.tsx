import {
  Dialog as FluentDialog,
  DialogActions,
  DialogBody as FluentDialogBody,
  DialogContent as FluentDialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';
import { useCallback } from 'react';

// Re-export Fluent primitives for advanced usage
export { DialogTrigger };

// ── Styles ──────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  surface: {
    backgroundColor: tokens.colorNeutralBackground2,
    maxWidth: '32rem',
    width: '100%',
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});

// ── DialogContent ───────────────────────────────────────────────────────────
// Maps to FluentDialogSurface. Accepts className for max-width overrides.

export const DialogContent = ({ className, children }: PropsWithChildren<{ className?: string }>) => {
  const styles = useStyles();
  return (
    <DialogSurface className={mergeClasses(styles.surface, className)}>
      <FluentDialogBody>{children}</FluentDialogBody>
    </DialogSurface>
  );
};

// ── DialogHeader ────────────────────────────────────────────────────────────
// Maps to FluentDialogTitle with a built-in close action.

export const DialogHeader = ({ className, children }: PropsWithChildren<{ className?: string }>) => {
  const styles = useStyles();
  return (
    <DialogTitle className={mergeClasses(styles.title, className)} action={<DialogTrigger action="close" />}>
      {children}
    </DialogTitle>
  );
};

// ── DialogBody ──────────────────────────────────────────────────────────────
// Maps to FluentDialogContent (the scrollable content area inside DialogBody).

export const DialogBody = ({ className, children }: PropsWithChildren<{ className?: string }>) => {
  return <FluentDialogContent className={className}>{children}</FluentDialogContent>;
};

// ── DialogFooter ────────────────────────────────────────────────────────────
// Maps to FluentDialogActions.

export const DialogFooter = ({ className, children }: PropsWithChildren<{ className?: string }>) => {
  return <DialogActions className={className}>{children}</DialogActions>;
};

// ── AnimatedDialog ──────────────────────────────────────────────────────────
// Controlled open/close wrapper — maps to Fluent Dialog with open + onOpenChange.

export const AnimatedDialog = ({
  open,
  onClose,
  children,
}: PropsWithChildren<{ open: boolean; onClose?: () => void }>) => {
  const handleOpenChange = useCallback(
    (_event: unknown, data: { open: boolean }) => {
      if (!data.open) {
        onClose?.();
      }
    },
    [onClose]
  );

  return (
    <FluentDialog open={open} onOpenChange={handleOpenChange} modalType="modal">
      {open && children}
    </FluentDialog>
  );
};
