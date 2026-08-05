import { Globe, Music2, Newspaper, PanelsTopLeft, Presentation, Star, Users, Video } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import { uuidv4 } from '@/lib/uuid';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { Switch } from '@/renderer/ds/ui/switch';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CustomAppEntry } from '@/shared/app-registry';

type LucideIcon = typeof Globe;

const ICON_OPTIONS: { name: string; Icon: LucideIcon }[] = [
  { name: 'Globe', Icon: Globe },
  { name: 'Users', Icon: Users },
  { name: 'Video', Icon: Video },
  { name: 'Music2', Icon: Music2 },
  { name: 'Newspaper', Icon: Newspaper },
  { name: 'Star', Icon: Star },
  { name: 'PanelsTopLeft', Icon: PanelsTopLeft },
  { name: 'Presentation', Icon: Presentation },
];

function isValidUrl(str: string): boolean {
  const trimmed = str.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

type AppFormDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Custom web-app creation form (label, URL, icon, dock scope). Ported from
 * the retired Settings → Apps tab; writes directly to the persisted store's
 * `customApps`, which the rest of the page observes reactively.
 */
export const AppFormDialog = memo(({ open, onClose }: AppFormDialogProps) => {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [icon, setIcon] = useState('Globe');
  const [columnScoped, setColumnScoped] = useState(false);

  useEffect(() => {
    if (open) {
      setLabel('');
      setUrl('');
      setIcon('Globe');
      setColumnScoped(false);
    }
  }, [open]);

  const isValid = label.trim().length > 0 && isValidUrl(url);

  const handleAdd = () => {
    if (!isValid) {
      return;
    }
    const current = persistedStoreApi.$atom.get().customApps ?? [];
    const maxOrder = current.reduce((max, a) => Math.max(max, a.order), 40);
    const entry: CustomAppEntry = {
      id: uuidv4(),
      label: label.trim(),
      icon,
      url: url.trim(),
      order: maxOrder + 10,
      columnScoped,
    };
    void persistedStoreApi.setKey('customApps', [...current, entry]);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add custom app</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4">
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Label</FieldLabel>
              </div>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Teams" autoFocus />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>URL</FieldLabel>
              </div>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." type="url" />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Icon</FieldLabel>
              </div>
              <div className="flex flex-wrap gap-1 mt-1">
                {ICON_OPTIONS.map(({ name, Icon: Ic }) => (
                  <Button
                    key={name}
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'flex items-center justify-center w-9 h-9 rounded-lg border border-border bg-transparent cursor-pointer text-muted-foreground transition-colors duration-150 hover:border border-border hover:text-foreground',
                      icon === name && 'border border-primary bg-primary/10 text-primary'
                    )}
                    onClick={() => setIcon(name)}
                    aria-label={name}
                    title={name}
                  >
                    <Ic className="size-5" />
                  </Button>
                ))}
              </div>
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Show in session dock</FieldLabel>
              </div>
              <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none">
                <Switch checked={columnScoped} onCheckedChange={setColumnScoped} />
                <span>
                  {columnScoped
                    ? "Available column-scoped — visible in each session's dock."
                    : 'Global only — opens as its own deck column via the app launcher.'}
                </span>
              </label>
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!isValid}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
AppFormDialog.displayName = 'AppFormDialog';
