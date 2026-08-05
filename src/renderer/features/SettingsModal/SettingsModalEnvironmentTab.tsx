import { Plus, Trash2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { SaveBar } from '@/renderer/ds/SaveBar';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Input } from '@/renderer/ds/ui/input';
import { SettingsPane, SettingsSection } from '@/renderer/features/SettingsModal/SettingsLayout';
import { agentConfigApi, configApi } from '@/renderer/services/config';
import { isElectron } from '@/renderer/services/ipc';

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
  const [envFilePath, setEnvFilePath] = useState<string | null>(null);
  const [lines, setLines] = useState<EnvLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) {
      return;
    }
    didInit.current = true;

    const init = async () => {
      try {
        setEnvFilePath(await configApi.getEnvFilePath());
        setLines(parseEnvContent(await agentConfigApi.getEnv()));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load environment file');
      }
    };

    init();
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
    setSaving(true);
    setError(null);
    try {
      await agentConfigApi.setEnv(serializeEnvLines(lines));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [lines]);

  return (
    <SettingsPane>
      {/* The on-disk path is meaningful only on desktop; in hosted mode `.env`
          is injected straight into the agent env (no file). */}
      {isElectron && (
        <SettingsSection title="Environment file">
          <Card>
            <CardContent>
              <span className="text-sm text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap sm:text-xs">
                {envFilePath ?? 'Loading\u2026'}
              </span>
            </CardContent>
          </Card>
        </SettingsSection>
      )}

      <SettingsSection title="Variables">
        <Card>
          <CardContent className="flex flex-col gap-4">
            {lines.map((line, i) => {
              if (line.kind === 'blank') {
                return null;
              }
              if (line.kind === 'comment') {
                return (
                  <div key={i} className="text-sm text-muted-foreground font-mono opacity-60 sm:text-xs">
                    {line.text}
                  </div>
                );
              }
              return <EnvEntryRow key={i} index={i} line={line} onUpdate={updateEntry} onRemove={removeEntry} />;
            })}

            <Button size="sm" variant="ghost" onClick={addEntry} className="self-start mt-0.5">
              <Plus className="mr-1" />
              Add variable
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
    </SettingsPane>
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
        <Input type="text" value={line.key} onChange={onChangeKey} placeholder="KEY" className="flex-1" />
        <span className="text-muted-foreground text-sm sm:text-xs">=</span>
        <Input type="text" value={line.value} onChange={onChangeValue} placeholder="value" className="grow-2 basis-0" />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove variable" onClick={onClickRemove}>
          <Trash2 />
        </Button>
      </div>
    );
  }
);
EnvEntryRow.displayName = 'EnvEntryRow';
