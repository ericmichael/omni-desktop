import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';

import { makeStyles, tokens } from '@fluentui/react-components';
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Button, FormField, FormSkeleton, IconButton, Input, SaveBar, SectionLabel, Select } from '@/renderer/ds';
import { configApi } from '@/renderer/services/config';
import type { McpConfig, McpServerEntry } from '@/shared/types';

const SERVER_TYPES: NonNullable<McpServerEntry['type']>[] = ['stdio', 'sse', 'http', 'streamable_http'];

function emptyConfig(): McpConfig {
  return { mcpServers: {} };
}

function emptyServer(): McpServerEntry {
  return { type: 'stdio', command: '', args: [] };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  addRow: {
    padding: tokens.spacingVerticalL,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  flex1: { flex: '1 1 0' },
  flex2: { flex: '2 1 0' },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flex: '1 1 0',
    minWidth: 0,
  },
  headerContent: { flex: '1 1 0', minWidth: 0 },
  headerName: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
  },
  headerSummary: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  panelBody: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  kvSection: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  kvLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  kvRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  selfStart: { alignSelf: 'flex-start' },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
});

export const SettingsModalMcpTab = memo(() => {
  const styles = useStyles();
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [newServerName, setNewServerName] = useState('');

  const filePath = configDir ? `${configDir}/mcp.json` : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dir = await configApi.getOmniConfigDir();
      setConfigDir(dir);
      const data = await configApi.readJsonFile(`${dir}/mcp.json`);
      if (data && typeof data === 'object' && 'mcpServers' in data) {
        setConfig(data as McpConfig);
      } else {
        const newConfig = emptyConfig();
        await configApi.writeJsonFile(`${dir}/mcp.json`, newConfig);
        setConfig(newConfig);
      }
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!filePath || !config) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await configApi.writeJsonFile(filePath, config);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [filePath, config]);

  const updateConfig = useCallback((updater: (prev: McpConfig) => McpConfig) => {
    setConfig((prev) => {
      if (!prev) {
        return prev;
      }
      return updater(prev);
    });
    setDirty(true);
  }, []);

  const addServer = useCallback(() => {
    const name = newServerName.trim();
    if (!name) {
      return;
    }
    updateConfig((c) => ({
      ...c,
      mcpServers: { ...c.mcpServers, [name]: emptyServer() },
    }));
    setExpandedServer(name);
    setNewServerName('');
  }, [newServerName, updateConfig]);

  const removeServer = useCallback(
    (name: string) => {
      updateConfig((c) => {
        const { [name]: _, ...rest } = c.mcpServers;
        return { ...c, mcpServers: rest };
      });
      if (expandedServer === name) {
        setExpandedServer(null);
      }
    },
    [expandedServer, updateConfig]
  );

  const updateServer = useCallback(
    (name: string, updater: (prev: McpServerEntry) => McpServerEntry) => {
      updateConfig((c) => {
        const server = c.mcpServers[name];
        if (!server) {
          return c;
        }
        return {
          ...c,
          mcpServers: { ...c.mcpServers, [name]: updater(server) },
        };
      });
    },
    [updateConfig]
  );

  const onChangeNewServerName = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewServerName(e.target.value);
  }, []);

  if (loading || !config) {
    return <FormSkeleton fields={4} />;
  }

  return (
    <div className={styles.root}>
      <SectionLabel>MCP Servers</SectionLabel>
      <Accordion collapsible onToggle={(_e, data) => {
        setExpandedServer(data.openItems.length > 0 ? String(data.openItems[data.openItems.length - 1]) : null);
      }} openItems={expandedServer ? [expandedServer] : []}>
        {Object.entries(config.mcpServers).map(([name, server]) => (
          <McpServerRow
            key={name}
            name={name}
            server={server}
            onRemove={removeServer}
            onUpdate={updateServer}
          />
        ))}
      </Accordion>
      <div className={styles.addRow}>
        <Input
          type="text"
          value={newServerName}
          onChange={onChangeNewServerName}
          placeholder="Server name"
          mono
          className={styles.flex1}
        />
        <Button size="sm" variant="ghost" onClick={addServer} isDisabled={!newServerName.trim()}>
          <Add20Regular className={styles.iconMr} />
          Add server
        </Button>
      </div>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
    </div>
  );
});
SettingsModalMcpTab.displayName = 'SettingsModalMcpTab';

const McpServerRow = memo(
  ({
    name,
    server,
    onRemove,
    onUpdate,
  }: {
    name: string;
    server: McpServerEntry;
    onRemove: (name: string) => void;
    onUpdate: (name: string, updater: (prev: McpServerEntry) => McpServerEntry) => void;
  }) => {
    const styles = useStyles();
    const isStdio = !server.type || server.type === 'stdio';
    const summary = isStdio ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : (server.url ?? '');

    const onClickRemove = useCallback(() => onRemove(name), [name, onRemove]);

    const onChangeType = useCallback(
      (e: ChangeEvent<HTMLSelectElement>) => {
        onUpdate(name, (s) => ({ ...s, type: e.target.value as McpServerEntry['type'] }));
      },
      [name, onUpdate]
    );
    const onChangeCommand = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        onUpdate(name, (s) => ({ ...s, command: e.target.value }));
      },
      [name, onUpdate]
    );
    const onChangeArgs = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        onUpdate(name, (s) => ({ ...s, args: e.target.value.split(',').map((a) => a.trim()) }));
      },
      [name, onUpdate]
    );
    const onChangeUrl = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        onUpdate(name, (s) => ({ ...s, url: e.target.value }));
      },
      [name, onUpdate]
    );

    const onAddEnvVar = useCallback(() => {
      onUpdate(name, (s) => ({ ...s, env: { ...(s.env ?? {}), '': '' } }));
    }, [name, onUpdate]);

    const onAddHeader = useCallback(() => {
      onUpdate(name, (s) => ({ ...s, headers: { ...(s.headers ?? {}), '': '' } }));
    }, [name, onUpdate]);

    return (
      <AccordionItem value={name}>
        <AccordionHeader expandIconPosition="end">
          <div className={styles.headerRow}>
            <div className={styles.headerContent}>
              <div className={styles.headerName}>{name}</div>
              <div className={styles.headerSummary}>
                {server.type ?? 'stdio'} &middot; {summary || '(not configured)'}
              </div>
            </div>
            <IconButton aria-label="Remove server" icon={<Delete20Regular />} size="sm" onClick={onClickRemove} />
          </div>
        </AccordionHeader>
        <AccordionPanel>
          <div className={styles.panelBody}>
            <FormField label="Type">
              <Select value={server.type ?? 'stdio'} onChange={onChangeType}>
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
                    value={server.command ?? ''}
                    onChange={onChangeCommand}
                    placeholder="npx"
                    mono
                    className={styles.flex1}
                  />
                </FormField>
                <FormField label="Args">
                  <Input
                    type="text"
                    value={(server.args ?? []).join(', ')}
                    onChange={onChangeArgs}
                    placeholder="arg1, arg2"
                    mono
                    className={styles.flex1}
                  />
                </FormField>
              </>
            ) : (
              <FormField label="URL">
                <Input
                  type="text"
                  value={server.url ?? ''}
                  onChange={onChangeUrl}
                  placeholder="https://..."
                  mono
                  className={styles.flex1}
                />
              </FormField>
            )}

            {!isStdio && (
              <KeyValueSection
                label="Headers"
                entries={server.headers ?? {}}
                serverName={name}
                field="headers"
                onUpdate={onUpdate}
                onAdd={onAddHeader}
              />
            )}

            <KeyValueSection
              label="Environment variables"
              entries={server.env ?? {}}
              serverName={name}
              field="env"
              onUpdate={onUpdate}
              onAdd={onAddEnvVar}
            />
          </div>
        </AccordionPanel>
      </AccordionItem>
    );
  }
);
McpServerRow.displayName = 'McpServerRow';

const KeyValueSection = memo(
  ({
    label,
    entries,
    serverName,
    field,
    onUpdate,
    onAdd,
  }: {
    label: string;
    entries: Record<string, string>;
    serverName: string;
    field: 'env' | 'headers';
    onUpdate: (name: string, updater: (prev: McpServerEntry) => McpServerEntry) => void;
    onAdd: () => void;
  }) => {
    const styles = useStyles();
    const entryList = Object.entries(entries);

    return (
      <div className={styles.kvSection}>
        <span className={styles.kvLabel}>{label}</span>
        {entryList.map(([key, value], i) => (
          <KvRow
            key={i}
            index={i}
            entryKey={key}
            entryValue={value}
            serverName={serverName}
            field={field}
            onUpdate={onUpdate}
          />
        ))}
        <Button size="sm" variant="ghost" onClick={onAdd} className={styles.selfStart}>
          <Add20Regular className={styles.iconMr} />
          Add
        </Button>
      </div>
    );
  }
);
KeyValueSection.displayName = 'KeyValueSection';

const KvRow = memo(
  ({
    index,
    entryKey,
    entryValue,
    serverName,
    field,
    onUpdate,
  }: {
    index: number;
    entryKey: string;
    entryValue: string;
    serverName: string;
    field: 'env' | 'headers';
    onUpdate: (name: string, updater: (prev: McpServerEntry) => McpServerEntry) => void;
  }) => {
    const styles = useStyles();
    const onChangeKey = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const newKey = e.target.value;
        onUpdate(serverName, (s) => {
          const old = s[field] ?? {};
          const entries = Object.entries(old);
          entries[index] = [newKey, entries[index]?.[1] ?? ''];
          return { ...s, [field]: Object.fromEntries(entries) };
        });
      },
      [serverName, field, index, onUpdate]
    );

    const onChangeValue = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const newVal = e.target.value;
        onUpdate(serverName, (s) => {
          const old = s[field] ?? {};
          const entries = Object.entries(old);
          entries[index] = [entries[index]?.[0] ?? '', newVal];
          return { ...s, [field]: Object.fromEntries(entries) };
        });
      },
      [serverName, field, index, onUpdate]
    );

    const onClickRemove = useCallback(() => {
      onUpdate(serverName, (s) => {
        const old = s[field] ?? {};
        const entries = Object.entries(old).filter((_, i) => i !== index);
        return { ...s, [field]: Object.fromEntries(entries) };
      });
    }, [serverName, field, index, onUpdate]);

    return (
      <div className={styles.kvRow}>
        <Input
          size="sm"
          type="text"
          value={entryKey}
          onChange={onChangeKey}
          placeholder="KEY"
          mono
          className={styles.flex1}
        />
        <Input
          size="sm"
          type="text"
          value={entryValue}
          onChange={onChangeValue}
          placeholder="value"
          mono
          className={styles.flex2}
        />
        <IconButton aria-label="Remove" icon={<Delete20Regular />} size="sm" onClick={onClickRemove} />
      </div>
    );
  }
);
KvRow.displayName = 'KvRow';
