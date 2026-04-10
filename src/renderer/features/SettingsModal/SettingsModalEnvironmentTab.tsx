import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';

import { makeStyles, tokens } from '@fluentui/react-components';
import { Button, Card, IconButton, Input, SaveBar, SectionLabel } from '@/renderer/ds';
import { configApi } from '@/renderer/services/config';

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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  sectionLabelSpaced: { marginTop: tokens.spacingVerticalS },
  filePath: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  comment: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    fontFamily: 'monospace',
    opacity: 0.6,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  addButton: { alignSelf: 'flex-start', marginTop: tokens.spacingVerticalXXS },
  entryRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  flex1: { flex: '1 1 0' },
  flex2: { flex: '2 1 0' },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
  equals: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalEnvironmentTab = memo(() => {
  const styles = useStyles();
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
        const filePath = await configApi.getEnvFilePath();
        setEnvFilePath(filePath);
        const content = await configApi.readTextFile(filePath);
        if (content === null) {
          await configApi.writeTextFile(filePath, '');
          setLines([]);
        } else {
          setLines(parseEnvContent(content));
        }
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
    <div className={styles.root}>
      <SectionLabel>Environment File</SectionLabel>
      <Card>
        <span className={styles.filePath}>{envFilePath ?? 'Loading\u2026'}</span>
      </Card>

      <SectionLabel className={styles.sectionLabelSpaced}>Variables</SectionLabel>
      <Card className={styles.root}>
        {lines.map((line, i) => {
          if (line.kind === 'blank') {
            return null;
          }
          if (line.kind === 'comment') {
            return (
              <div key={i} className={styles.comment}>
                {line.text}
              </div>
            );
          }
          return <EnvEntryRow key={i} index={i} line={line} onUpdate={updateEntry} onRemove={removeEntry} />;
        })}

        <Button size="sm" variant="ghost" onClick={addEntry} className={styles.addButton}>
          <Add20Regular className={styles.iconMr} />
          Add variable
        </Button>
      </Card>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
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
    const styles = useStyles();
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
      <div className={styles.entryRow}>
        <Input
          type="text"
          value={line.key}
          onChange={onChangeKey}
          placeholder="KEY"
          mono
          className={styles.flex1}
        />
        <span className={styles.equals}>=</span>
        <Input
          size="sm"
          type="text"
          value={line.value}
          onChange={onChangeValue}
          placeholder="value"
          mono
          className={styles.flex2}
        />
        <IconButton aria-label="Remove variable" icon={<Delete20Regular />} size="sm" onClick={onClickRemove} />
      </div>
    );
  }
);
EnvEntryRow.displayName = 'EnvEntryRow';
