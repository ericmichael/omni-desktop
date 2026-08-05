import { Plus, Trash2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { SaveBar } from '@/renderer/ds/SaveBar';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
import { Switch } from '@/renderer/ds/ui/switch';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { agentConfigApi } from '@/renderer/services/config';
import type { NetworkConfig } from '@/shared/types';

type Preset = {
  id: string;
  label: string;
  description: string;
  hosts: string[];
};

const PRESETS: Preset[] = [
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    description: 'Azure OpenAI Service and Microsoft identity',
    hosts: ['*.openai.azure.com', 'cognitiveservices.azure.com', 'login.microsoftonline.com'],
  },
  {
    id: 'rgvaiclass',
    label: 'RGV AI Class',
    description: 'RGV AI Class platform',
    hosts: ['rgvaiclass.com'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI API endpoints',
    hosts: ['api.openai.com'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Anthropic Claude API',
    hosts: ['api.anthropic.com'],
  },
  {
    id: 'google-ai',
    label: 'Google AI',
    description: 'Google Gemini API',
    hosts: ['generativelanguage.googleapis.com'],
  },
];

/** All hosts belonging to any preset, used for stripping on load. */
const ALL_PRESET_HOSTS = new Set(PRESETS.flatMap((p) => p.hosts));

function emptyConfig(): NetworkConfig {
  return {
    enabled: false,
    presets: [],
    allowlist: [],
    denylist: [],
    allow_private_ips: false,
    enable_socks5: true,
  };
}

/** Migrate old-format config (allowedHosts) to new format (allowlist). */
function migrateConfig(data: Record<string, unknown>): NetworkConfig {
  const base = emptyConfig();

  base.enabled = typeof data['enabled'] === 'boolean' ? data['enabled'] : false;
  base.presets = Array.isArray(data['presets']) ? (data['presets'] as string[]) : [];

  // Migrate allowedHosts → allowlist
  const rawAllowlist: string[] = Array.isArray(data['allowlist'])
    ? (data['allowlist'] as string[])
    : Array.isArray(data['allowedHosts'])
      ? (data['allowedHosts'] as string[])
      : [];

  // Strip preset hosts so the UI allowlist only shows manual entries
  base.allowlist = rawAllowlist.filter((h) => !ALL_PRESET_HOSTS.has(h));

  base.denylist = Array.isArray(data['denylist']) ? (data['denylist'] as string[]) : [];
  base.allow_private_ips = typeof data['allow_private_ips'] === 'boolean' ? data['allow_private_ips'] : false;
  base.enable_socks5 = typeof data['enable_socks5'] === 'boolean' ? data['enable_socks5'] : true;

  return base;
}

/** Expand selected presets into the allowlist and merge with manual hosts. */
function buildSavePayload(config: NetworkConfig): NetworkConfig {
  const presetHosts = PRESETS.filter((p) => config.presets.includes(p.id)).flatMap((p) => p.hosts);
  const mergedAllowlist = [...new Set([...presetHosts, ...config.allowlist])];
  return { ...config, allowlist: mergedAllowlist };
}

export const SettingsModalNetworkTab = memo(() => {
  const [config, setConfig] = useState<NetworkConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newHost, setNewHost] = useState('');
  const [newDenyHost, setNewDenyHost] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Stored config holds the expanded (preset-merged) shape; `migrateConfig`
      // strips preset hosts back out so the UI allowlist shows only manual entries.
      const data = await agentConfigApi.getNetwork();
      setConfig(migrateConfig(data as unknown as Record<string, unknown>));
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
    if (!config) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await agentConfigApi.setNetwork(buildSavePayload(config));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const updateConfig = useCallback((updater: (prev: NetworkConfig) => NetworkConfig) => {
    setConfig((prev) => {
      if (!prev) {
        return prev;
      }
      return updater(prev);
    });
    setDirty(true);
  }, []);

  const onToggleEnabled = useCallback(
    (checked: boolean) => {
      updateConfig((c) => ({ ...c, enabled: checked }));
    },
    [updateConfig]
  );

  const onToggleAllowPrivateIps = useCallback(
    (checked: boolean) => {
      updateConfig((c) => ({ ...c, allow_private_ips: checked }));
    },
    [updateConfig]
  );

  // Allowlist handlers
  const onChangeNewHost = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewHost(e.target.value);
  }, []);

  const addHost = useCallback(() => {
    const host = newHost.trim();
    if (!host) {
      return;
    }
    updateConfig((c) => ({ ...c, allowlist: [...c.allowlist, host] }));
    setNewHost('');
  }, [newHost, updateConfig]);

  const onNewHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addHost();
      }
    },
    [addHost]
  );

  const removeHost = useCallback(
    (index: number) => {
      updateConfig((c) => ({
        ...c,
        allowlist: c.allowlist.filter((_, i) => i !== index),
      }));
    },
    [updateConfig]
  );

  // Denylist handlers
  const onChangeNewDenyHost = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewDenyHost(e.target.value);
  }, []);

  const addDenyHost = useCallback(() => {
    const host = newDenyHost.trim();
    if (!host) {
      return;
    }
    updateConfig((c) => ({ ...c, denylist: [...c.denylist, host] }));
    setNewDenyHost('');
  }, [newDenyHost, updateConfig]);

  const onNewDenyHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addDenyHost();
      }
    },
    [addDenyHost]
  );

  const removeDenyHost = useCallback(
    (index: number) => {
      updateConfig((c) => ({
        ...c,
        denylist: c.denylist.filter((_, i) => i !== index),
      }));
    },
    [updateConfig]
  );

  const togglePreset = useCallback(
    (presetId: string) => {
      updateConfig((c) => {
        const has = c.presets.includes(presetId);
        return {
          ...c,
          presets: has ? c.presets.filter((p) => p !== presetId) : [...c.presets, presetId],
        };
      });
    },
    [updateConfig]
  );

  const effectiveHosts = useMemo(() => {
    if (!config) {
      return [];
    }
    const presetHosts = PRESETS.filter((p) => config.presets.includes(p.id)).flatMap((p) => p.hosts);
    return [...new Set([...presetHosts, ...config.allowlist])];
  }, [config]);

  if (loading || !config) {
    return (
      <div className="flex w-full flex-col gap-5 p-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className={`h-3 ${['w-15', 'w-18', 'w-20'][index % 3]}`} />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <SettingsPane>
      <SettingsSection title="Network isolation">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Enable network isolation</FieldLabel>
              </div>
              <Switch checked={config.enabled} onCheckedChange={onToggleEnabled} />
            </Field>

            <p className="text-sm text-muted-foreground sm:text-xs">
              When enabled, outbound network traffic is restricted to the hosts listed below in both chat and sandbox
              modes. All other traffic is blocked. Hosts can be domain names, IP addresses, or CIDR ranges.
            </p>

            {config.enabled && (
              <>
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-muted-foreground sm:text-xs">Presets</span>
                  <div className="flex flex-col gap-2">
                    {PRESETS.map((preset) => (
                      <PresetRow
                        key={preset.id}
                        preset={preset}
                        checked={config.presets.includes(preset.id)}
                        onToggle={togglePreset}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-muted-foreground sm:text-xs">Additional allowed hosts</span>
                  <div className="flex flex-col gap-1">
                    {config.allowlist.map((host, i) => (
                      <HostRow key={i} host={host} index={i} onRemove={removeHost} />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={newHost}
                      onChange={onChangeNewHost}
                      onKeyDown={onNewHostKeyDown}
                      placeholder="example.openai.azure.com or 10.0.0.0/16"
                      className="flex-1"
                    />

                    <Button size="sm" variant="ghost" onClick={addHost} disabled={!newHost.trim()}>
                      <Plus className="mr-1" />
                      Add host
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-muted-foreground sm:text-xs">Denied hosts</span>
                  <p className="text-sm text-muted-foreground sm:text-xs">
                    Explicitly blocked hosts. Denied hosts take precedence over allowed hosts.
                  </p>
                  <div className="flex flex-col gap-1">
                    {config.denylist.map((host, i) => (
                      <HostRow key={i} host={host} index={i} onRemove={removeDenyHost} />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={newDenyHost}
                      onChange={onChangeNewDenyHost}
                      onKeyDown={onNewDenyHostKeyDown}
                      placeholder="blocked.example.com"
                      className="flex-1"
                    />

                    <Button size="sm" variant="ghost" onClick={addDenyHost} disabled={!newDenyHost.trim()}>
                      <Plus className="mr-1" />
                      Add denied host
                    </Button>
                  </div>
                </div>

                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Allow private IP ranges (10.x, 172.16.x, 192.168.x)</FieldLabel>
                  </div>
                  <Switch checked={config.allow_private_ips} onCheckedChange={onToggleAllowPrivateIps} />
                </Field>

                {effectiveHosts.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-muted-foreground sm:text-xs">Effective allowlist</span>
                    <p className="text-sm text-muted-foreground font-mono sm:text-xs">{effectiveHosts.join(', ')}</p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </SettingsSection>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
    </SettingsPane>
  );
});
SettingsModalNetworkTab.displayName = 'SettingsModalNetworkTab';

const PresetRow = memo(
  ({ preset, checked, onToggle }: { preset: Preset; checked: boolean; onToggle: (id: string) => void }) => {
    const onChange = useCallback(() => onToggle(preset.id), [preset.id, onToggle]);

    return (
      <label className="flex items-center gap-2.5 cursor-pointer pt-0.5 pb-0.5">
        <Checkbox checked={checked} onCheckedChange={onChange} />
        <div className="flex flex-col">
          <span className="text-sm font-medium text-foreground sm:text-xs">{preset.label}</span>
          <span className="text-sm text-muted-foreground sm:text-xs">{preset.description}</span>
        </div>
      </label>
    );
  }
);
PresetRow.displayName = 'PresetRow';

const HostRow = memo(
  ({ host, index, onRemove }: { host: string; index: number; onRemove: (index: number) => void }) => {
    const onClickRemove = useCallback(() => onRemove(index), [index, onRemove]);

    return (
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className="h-9 min-w-0 flex-1 justify-start truncate rounded-md px-4 font-mono font-normal sm:h-8 sm:px-2"
        >
          {host}
        </Badge>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove host" onClick={onClickRemove}>
          <Trash2 />
        </Button>
      </div>
    );
  }
);
HostRow.displayName = 'HostRow';
