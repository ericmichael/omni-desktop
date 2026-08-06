import { Plus, Trash2 } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Spinner } from '@/renderer/ds/ui/spinner';
import type { McpServerEntry } from '@/shared/types';

const SERVER_TYPES: NonNullable<McpServerEntry['type']>[] = ['stdio', 'sse', 'http', 'streamable_http'];

export function emptyServer(): McpServerEntry {
  return { type: 'stdio', command: '', args: [] };
}

type KeyValueEditorProps = {
  label: string;
  entries: Record<string, string>;
  storedKeys?: string[];
  onChange: (next: Record<string, string>) => void;
};

/** Ordered key/value editor over a Record — index-based so keys can be typed freely. */
const KeyValueEditor = memo(({ label, entries, storedKeys = [], onChange }: KeyValueEditorProps) => {
  const entryList = Object.entries(entries);
  const stored = new Set(storedKeys);

  const setAt = (index: number, key: string, value: string) => {
    const next = entryList.slice();
    next[index] = [key, value];
    onChange(Object.fromEntries(next));
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {entryList.map(([key, value], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            type="text"
            value={key}
            onChange={(e) => setAt(i, e.target.value, value)}
            placeholder="KEY"
            className="flex-1"
          />

          <Input
            type="password"
            value={value}
            onChange={(e) => setAt(i, key, e.target.value)}
            placeholder={stored.has(key) && value.length === 0 ? 'Stored value — leave blank to keep' : 'value'}
            aria-label={`${label} ${key || 'value'}`}
            className="grow-2 basis-0"
          />

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove"
            onClick={() => onChange(Object.fromEntries(entryList.filter((_, j) => j !== i)))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange({ ...entries, '': '' })} className="self-start">
        <Plus className="mr-1" />
        Add
      </Button>
    </div>
  );
});
KeyValueEditor.displayName = 'KeyValueEditor';

type ConnectorConfigDialogProps = {
  open: boolean;
  /** Existing server id to edit, or null to create a new one (name becomes editable). */
  serverId: string | null;
  initial: McpServerEntry | null;
  /** Ids already present in McpConfig — validates a new server's name. */
  existingIds: string[];
  /** Secret key names returned by the runtime as write-only presence markers. */
  storedSecrets?: { env: string[]; headers: string[] };
  onSave: (id: string, entry: McpServerEntry) => Promise<void>;
  onClose: () => void;
};

/**
 * Per-server MCP configuration form (type, command/URL, headers, env vars).
 * Ported from the retired Settings → MCP Servers accordion; saving replaces
 * the one entry in McpConfig via the caller.
 */
export const ConnectorConfigDialog = memo(
  ({ open, serverId, initial, existingIds, storedSecrets, onSave, onClose }: ConnectorConfigDialogProps) => {
    const creating = serverId === null;
    const [id, setId] = useState('');
    const [draft, setDraft] = useState<McpServerEntry>(emptyServer);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      if (open) {
        setId(serverId ?? '');
        setDraft(initial ?? emptyServer());
        setSaving(false);
        setError(null);
      }
    }, [open, serverId, initial]);

    const isStdio = !draft.type || draft.type === 'stdio';
    const trimmedId = id.trim();
    const idTaken = creating && existingIds.includes(trimmedId);
    const canSave = trimmedId.length > 0 && !idTaken && !saving;

    const save = async () => {
      setSaving(true);
      setError(null);
      try {
        await onSave(trimmedId, draft);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save connector');
        setSaving(false);
      }
    };

    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{creating ? 'Add MCP server' : `Configure "${serverId}"`}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-4">
              {error && <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-xs">{error}</div>}

              {creating && (
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Name</FieldLabel>
                  </div>
                  <Input
                    type="text"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder="my-server"
                    autoFocus
                  />
                </Field>
              )}
              {idTaken && (
                <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-xs">
                  A server named &quot;{trimmedId}&quot; already exists.
                </div>
              )}

              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>Type</FieldLabel>
                </div>
                <Select
                  value={draft.type ?? 'stdio'}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      type: e.target.value as McpServerEntry['type'],
                    })
                  }
                >
                  {SERVER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>

              {isStdio ? (
                <>
                  <Field orientation="horizontal" className="justify-between gap-4">
                    <div className="min-w-0">
                      <FieldLabel>Command</FieldLabel>
                    </div>
                    <Input
                      type="text"
                      value={draft.command ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          command: e.target.value,
                        })
                      }
                      placeholder="npx"
                    />
                  </Field>
                  <Field orientation="horizontal" className="justify-between gap-4">
                    <div className="min-w-0">
                      <FieldLabel>Args</FieldLabel>
                    </div>
                    <Input
                      type="text"
                      value={(draft.args ?? []).join(', ')}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          args: e.target.value.split(',').map((a) => a.trim()),
                        })
                      }
                      placeholder="arg1, arg2"
                    />
                  </Field>
                </>
              ) : (
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>URL</FieldLabel>
                  </div>
                  <Input
                    type="text"
                    value={draft.url ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        url: e.target.value,
                      })
                    }
                    placeholder="https://..."
                  />
                </Field>
              )}

              {!isStdio && (
                <KeyValueEditor
                  label="Headers"
                  entries={draft.headers ?? {}}
                  storedKeys={storedSecrets?.headers}
                  onChange={(headers) => setDraft({ ...draft, headers })}
                />
              )}

              {isStdio && (
                <KeyValueEditor
                  label="Environment variables"
                  entries={draft.env ?? {}}
                  storedKeys={storedSecrets?.env}
                  onChange={(env) => setDraft({ ...draft, env })}
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!canSave}>
              {saving ? <Spinner /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
ConnectorConfigDialog.displayName = 'ConnectorConfigDialog';
