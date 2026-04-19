/**
 * Modal for creating a new browser profile. Replaces the native
 * `window.prompt` so the flow matches the rest of the Fluent chrome — input
 * with validation, incognito toggle, Enter to submit, Escape to cancel.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  Checkbox,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FormField,
  Input,
} from '@/renderer/ds';

export const NewProfileDialog = memo(
  ({
    open,
    defaultIncognito = false,
    onClose,
    onCreate,
  }: {
    open: boolean;
    defaultIncognito?: boolean;
    onClose: () => void;
    onCreate: (input: { label: string; incognito: boolean }) => void;
  }) => {
    const [label, setLabel] = useState('');
    const [incognito, setIncognito] = useState(defaultIncognito);
    const inputRef = useRef<HTMLInputElement>(null);

    // Reset the form each time the dialog opens so stale input doesn't leak
    // between invocations.
    useEffect(() => {
      if (open) {
        setLabel('');
        setIncognito(defaultIncognito);
        // Autofocus after the dialog animates in.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }, [open, defaultIncognito]);

    const submit = useCallback(() => {
      const trimmed = label.trim();
      if (!trimmed) return;
      onCreate({ label: trimmed, incognito });
      onClose();
    }, [incognito, label, onClose, onCreate]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      },
      [submit]
    );

    return (
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent>
          <DialogHeader>New profile</DialogHeader>
          <DialogBody>
            <FormField label="Name">
              <Input
                ref={inputRef}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Work, Personal, …"
              />
            </FormField>
            <Checkbox
              checked={incognito}
              onCheckedChange={(c) => setIncognito(c)}
              label="Incognito (no persistent cookies or cache)"
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} isDisabled={!label.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
NewProfileDialog.displayName = 'NewProfileDialog';
