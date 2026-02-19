import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { PiCaretDownBold, PiCaretUpBold, PiPlusBold, PiTrashBold } from 'react-icons/pi';

import { Button, FormField, IconButton, Spinner } from '@/renderer/ds';
import { configApi } from '@/renderer/services/config';
import type { McpConfig, McpServerEntry } from '@/shared/types';

const SERVER_TYPES: NonNullable<McpServerEntry['type']>[] = ['stdio', 'sse', 'http', 'streamable_http'];

function emptyConfig(): McpConfig {
  return { mcpServers: {} };
}

function emptyServer(): McpServerEntry {
  return { type: 'stdio', command: '', args: [] };
}

export const SettingsModalMcpTab = memo(() => {
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
        setConfig(null);
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

  const createConfig = useCallback(async () => {
    if (!filePath) {
      return;
    }
    const newConfig = emptyConfig();
    setSaving(true);
    try {
      await configApi.writeJsonFile(filePath, newConfig);
      setConfig(newConfig);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  }, [filePath]);

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

  const toggleServer = useCallback((name: string) => {
    setExpandedServer((prev) => (prev === name ? null : name));
  }, []);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <span className="text-sm text-fg-muted">No mcp.json found</span>
        <Button size="sm" variant="primary" onClick={createConfig} isDisabled={saving}>
          Create mcp.json
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">MCP Servers</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 divide-y divide-surface-border/50">
        {Object.entries(config.mcpServers).map(([name, server]) => (
          <McpServerRow
            key={name}
            name={name}
            server={server}
            isExpanded={expandedServer === name}
            onToggle={toggleServer}
            onRemove={removeServer}
            onUpdate={updateServer}
          />
        ))}
        <div className="p-4 flex items-center gap-2">
          <input
            type="text"
            value={newServerName}
            onChange={onChangeNewServerName}
            placeholder="Server name"
            className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
          />
          <Button size="sm" variant="ghost" onClick={addServer} isDisabled={!newServerName.trim()}>
            <PiPlusBold className="mr-1" />
            Add server
          </Button>
        </div>
      </div>

      {error && <span className="text-xs text-red-400">{error}</span>}

      <div className="flex items-center gap-2 mt-1">
        <Button size="sm" variant="primary" onClick={save} isDisabled={!dirty || saving}>
          {saving ? 'Saving\u2026' : 'Save'}
        </Button>
        {dirty && <span className="text-xs text-fg-subtle">Unsaved changes</span>}
      </div>
    </div>
  );
});
SettingsModalMcpTab.displayName = 'SettingsModalMcpTab';

const McpServerRow = memo(
  ({
    name,
    server,
    isExpanded,
    onToggle,
    onRemove,
    onUpdate,
  }: {
    name: string;
    server: McpServerEntry;
    isExpanded: boolean;
    onToggle: (name: string) => void;
    onRemove: (name: string) => void;
    onUpdate: (name: string, updater: (prev: McpServerEntry) => McpServerEntry) => void;
  }) => {
    const isStdio = !server.type || server.type === 'stdio';
    const summary = isStdio ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : (server.url ?? '');

    const onClickToggle = useCallback(() => onToggle(name), [name, onToggle]);
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
      <div className="flex flex-col">
        <div className="flex items-center gap-2 p-4 cursor-pointer" onClick={onClickToggle}>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-fg">{name}</div>
            <div className="text-xs text-fg-muted truncate">
              {server.type ?? 'stdio'} &middot; {summary || '(not configured)'}
            </div>
          </div>
          {isExpanded ? (
            <PiCaretUpBold className="text-fg-muted text-xs" />
          ) : (
            <PiCaretDownBold className="text-fg-muted text-xs" />
          )}
          <IconButton aria-label="Remove server" icon={<PiTrashBold />} size="sm" onClick={onClickRemove} />
        </div>

        {isExpanded && (
          <div className="px-4 pb-4 flex flex-col gap-3 border-t border-surface-border/30 pt-3">
            <FormField label="Type">
              <select
                value={server.type ?? 'stdio'}
                onChange={onChangeType}
                className="h-8 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
              >
                {SERVER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>

            {isStdio ? (
              <>
                <FormField label="Command">
                  <input
                    type="text"
                    value={server.command ?? ''}
                    onChange={onChangeCommand}
                    placeholder="npx"
                    className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
                  />
                </FormField>
                <FormField label="Args">
                  <input
                    type="text"
                    value={(server.args ?? []).join(', ')}
                    onChange={onChangeArgs}
                    placeholder="arg1, arg2"
                    className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
                  />
                </FormField>
              </>
            ) : (
              <FormField label="URL">
                <input
                  type="text"
                  value={server.url ?? ''}
                  onChange={onChangeUrl}
                  placeholder="https://..."
                  className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
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
        )}
      </div>
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
    const entryList = Object.entries(entries);

    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-fg-subtle">{label}</span>
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
        <Button size="sm" variant="ghost" onClick={onAdd} className="self-start">
          <PiPlusBold className="mr-1" />
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
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={entryKey}
          onChange={onChangeKey}
          placeholder="KEY"
          className="h-7 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
        />
        <input
          type="text"
          value={entryValue}
          onChange={onChangeValue}
          placeholder="value"
          className="h-7 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-[2] outline-none focus:border-accent-500/50"
        />
        <IconButton aria-label="Remove" icon={<PiTrashBold />} size="sm" onClick={onClickRemove} />
      </div>
    );
  }
);
KvRow.displayName = 'KvRow';
