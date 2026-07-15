import { makeStyles, tokens } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { memo, useEffect, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FormField,
  IconButton,
  Input,
  Select,
  Spinner,
} from '@/renderer/ds';
import type { McpServerEntry } from '@/shared/types';

const SERVER_TYPES: NonNullable<McpServerEntry['type']>[] = ['stdio', 'sse', 'http', 'streamable_http'];

export function emptyServer(): McpServerEntry {
  return { type: 'stdio', command: '', args: [] };
}

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  kvSection: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  kvLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground3,
  },
  kvRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  flex1: { flex: '1 1 0' },
  flex2: { flex: '2 1 0' },
  selfStart: { alignSelf: 'flex-start' },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
  errorBanner: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

type KeyValueEditorProps = {
  label: string;
  entries: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
};

/** Ordered key/value editor over a Record — index-based so keys can be typed freely. */
const KeyValueEditor = memo(({ label, entries, onChange }: KeyValueEditorProps) => {
  const styles = useStyles();
  const entryList = Object.entries(entries);

  const setAt = (index: number, key: string, value: string) => {
    const next = entryList.slice();
    next[index] = [key, value];
    onChange(Object.fromEntries(next));
  };

  return (
    <div className={styles.kvSection}>
      <span className={styles.kvLabel}>{label}</span>
      {entryList.map(([key, value], i) => (
        <div key={i} className={styles.kvRow}>
          <Input
            size="sm"
            type="text"
            value={key}
            onChange={(e) => setAt(i, e.target.value, value)}
            placeholder="KEY"
            mono
            className={styles.flex1}
          />
          <Input
            size="sm"
            type="text"
            value={value}
            onChange={(e) => setAt(i, key, e.target.value)}
            placeholder="value"
            mono
            className={styles.flex2}
          />
          <IconButton
            aria-label="Remove"
            icon={<Delete20Regular />}
            size="sm"
            onClick={() => onChange(Object.fromEntries(entryList.filter((_, j) => j !== i)))}
          />
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange({ ...entries, '': '' })} className={styles.selfStart}>
        <Add20Regular className={styles.iconMr} />
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
  onSave: (id: string, entry: McpServerEntry) => Promise<void>;
  onClose: () => void;
};

/**
 * Per-server MCP configuration form (type, command/URL, headers, env vars).
 * Ported from the retired Settings → MCP Servers accordion; saving replaces
 * the one entry in McpConfig via the caller.
 */
export const ConnectorConfigDialog = memo(
  ({ open, serverId, initial, existingIds, onSave, onClose }: ConnectorConfigDialogProps) => {
    const styles = useStyles();
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
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent>
          <DialogHeader>{creating ? 'Add MCP server' : `Configure "${serverId}"`}</DialogHeader>
          <DialogBody>
            <div className={styles.form}>
              {error && <div className={styles.errorBanner}>{error}</div>}

              {creating && (
                <FormField label="Name">
                  <Input
                    type="text"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder="my-server"
                    mono
                    autoFocus
                  />
                </FormField>
              )}
              {idTaken && (
                <div className={styles.errorBanner}>A server named &quot;{trimmedId}&quot; already exists.</div>
              )}

              <FormField label="Type">
                <Select
                  value={draft.type ?? 'stdio'}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as McpServerEntry['type'] })}
                >
                  {SERVER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </FormField>

              {isStdio ? (
                <>
                  <FormField label="Command">
                    <Input
                      type="text"
                      value={draft.command ?? ''}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      placeholder="npx"
                      mono
                    />
                  </FormField>
                  <FormField label="Args">
                    <Input
                      type="text"
                      value={(draft.args ?? []).join(', ')}
                      onChange={(e) => setDraft({ ...draft, args: e.target.value.split(',').map((a) => a.trim()) })}
                      placeholder="arg1, arg2"
                      mono
                    />
                  </FormField>
                </>
              ) : (
                <FormField label="URL">
                  <Input
                    type="text"
                    value={draft.url ?? ''}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="https://..."
                    mono
                  />
                </FormField>
              )}

              {!isStdio && (
                <KeyValueEditor
                  label="Headers"
                  entries={draft.headers ?? {}}
                  onChange={(headers) => setDraft({ ...draft, headers })}
                />
              )}

              <KeyValueEditor
                label="Environment variables"
                entries={draft.env ?? {}}
                onChange={(env) => setDraft({ ...draft, env })}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} isDisabled={!canSave}>
              {saving ? <Spinner size="sm" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
ConnectorConfigDialog.displayName = 'ConnectorConfigDialog';
