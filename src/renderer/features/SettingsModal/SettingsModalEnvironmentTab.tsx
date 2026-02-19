import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiPlusBold, PiTrashBold } from 'react-icons/pi';

import { Button, IconButton } from '@/renderer/ds';
import { configApi } from '@/renderer/services/config';
import { persistedStoreApi, selectEnvFilePath } from '@/renderer/services/store';

type EnvLine = { kind: 'entry'; key: string; value: string } | { kind: 'comment'; text: string } | { kind: 'blank' };

function parseEnvContent(content: string): EnvLine[] {
  const lines: EnvLine[] = [];
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      lines.push({ kind: 'blank' });
    } else if (trimmed.startsWith('#')) {
      lines.push({ kind: 'comment', text: raw });
    } else {
      const eqIdx = raw.indexOf('=');
      if (eqIdx === -1) {
        lines.push({ kind: 'comment', text: raw });
      } else {
        lines.push({ kind: 'entry', key: raw.slice(0, eqIdx), value: raw.slice(eqIdx + 1) });
      }
    }
  }
  return lines;
}

function serializeEnvLines(lines: EnvLine[]): string {
  return lines
    .map((line) => {
      if (line.kind === 'blank') {
        return '';
      }
      if (line.kind === 'comment') {
        return line.text;
      }
      return `${line.key}=${line.value}`;
    })
    .join('\n');
}

export const SettingsModalEnvironmentTab = memo(() => {
  const { envFilePath } = useStore(persistedStoreApi.$atom);
  const [lines, setLines] = useState<EnvLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedPathRef = useRef<string | undefined>(undefined);

  const loadFile = useCallback(async (filePath: string | undefined) => {
    if (!filePath) {
      setLines([]);
      setDirty(false);
      return;
    }
    try {
      const content = await configApi.readTextFile(filePath);
      if (content !== null) {
        setLines(parseEnvContent(content));
      } else {
        setLines([]);
      }
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read file');
    }
  }, []);

  useEffect(() => {
    if (envFilePath !== loadedPathRef.current) {
      loadedPathRef.current = envFilePath;
      loadFile(envFilePath);
    }
  }, [envFilePath, loadFile]);

  const clearEnvFilePath = useCallback(() => {
    persistedStoreApi.setKey('envFilePath', undefined);
  }, []);

  const updateEntry = useCallback((index: number, field: 'key' | 'value', newVal: string) => {
    setLines((prev) => {
      const next = [...prev];
      const line = next[index];
      if (line && line.kind === 'entry') {
        next[index] = { ...line, [field]: newVal };
      }
      return next;
    });
    setDirty(true);
  }, []);

  const removeEntry = useCallback((index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }, []);

  const addEntry = useCallback(() => {
    setLines((prev) => [...prev, { kind: 'entry', key: '', value: '' }]);
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!envFilePath) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await configApi.writeTextFile(envFilePath, serializeEnvLines(lines));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [envFilePath, lines]);

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Environment File</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-muted truncate flex-1">{envFilePath ?? 'No file selected'}</span>
          <Button size="sm" variant="ghost" onClick={selectEnvFilePath}>
            Change
          </Button>
          {envFilePath && (
            <Button size="sm" variant="ghost" onClick={clearEnvFilePath}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {envFilePath && (
        <>
          <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Variables</span>
          <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-2">
            {lines.map((line, i) => {
              if (line.kind === 'blank') {
                return null;
              }
              if (line.kind === 'comment') {
                return (
                  <div key={i} className="text-xs text-fg-subtle font-mono opacity-60">
                    {line.text}
                  </div>
                );
              }
              return <EnvEntryRow key={i} index={i} line={line} onUpdate={updateEntry} onRemove={removeEntry} />;
            })}

            <Button size="sm" variant="ghost" onClick={addEntry} className="self-start mt-1">
              <PiPlusBold className="mr-1" />
              Add variable
            </Button>
          </div>

          {error && <span className="text-xs text-red-400">{error}</span>}

          <div className="flex items-center gap-2 mt-1">
            <Button size="sm" variant="primary" onClick={save} isDisabled={!dirty || saving}>
              {saving ? 'Saving\u2026' : 'Save'}
            </Button>
            {dirty && <span className="text-xs text-fg-subtle">Unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  );
});
SettingsModalEnvironmentTab.displayName = 'SettingsModalEnvironmentTab';

const EnvEntryRow = memo(
  ({
    index,
    line,
    onUpdate,
    onRemove,
  }: {
    index: number;
    line: { kind: 'entry'; key: string; value: string };
    onUpdate: (index: number, field: 'key' | 'value', value: string) => void;
    onRemove: (index: number) => void;
  }) => {
    const onChangeKey = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        onUpdate(index, 'key', e.target.value);
      },
      [index, onUpdate]
    );
    const onChangeValue = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        onUpdate(index, 'value', e.target.value);
      },
      [index, onUpdate]
    );
    const onClickRemove = useCallback(() => {
      onRemove(index);
    }, [index, onRemove]);

    return (
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={line.key}
          onChange={onChangeKey}
          placeholder="KEY"
          className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
        />
        <span className="text-fg-subtle text-xs">=</span>
        <input
          type="text"
          value={line.value}
          onChange={onChangeValue}
          placeholder="value"
          className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-[2] outline-none focus:border-accent-500/50"
        />
        <IconButton aria-label="Remove variable" icon={<PiTrashBold />} size="sm" onClick={onClickRemove} />
      </div>
    );
  }
);
EnvEntryRow.displayName = 'EnvEntryRow';
