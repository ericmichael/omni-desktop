import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Card, Checkbox, FormField, FormSkeleton, IconButton, Input, SaveBar, SectionLabel, Switch } from '@/renderer/ds';
import { configApi } from '@/renderer/services/config';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  cardGap4: { gap: tokens.spacingVerticalL },
  description: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  colGap2: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  colGap1: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  subLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  rowGap2: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  flex1: { flex: '1 1 0' },
  hostChip: {
    height: '36px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase300,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    color: tokens.colorNeutralForeground1,
    fontFamily: 'monospace',
    flex: '1 1 0',
    display: 'flex',
    alignItems: 'center',
    '@media (min-width: 640px)': {
      height: '32px',
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
      fontSize: tokens.fontSizeBase200,
    },
  },
  effectiveMono: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    fontFamily: 'monospace',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
  presetLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
    paddingTop: '2px',
    paddingBottom: '2px',
  },
  presetCol: { display: 'flex', flexDirection: 'column' },
  presetName: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  presetDesc: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalNetworkTab = memo(() => {
  const styles = useStyles();
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [config, setConfig] = useState<NetworkConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newHost, setNewHost] = useState('');
  const [newDenyHost, setNewDenyHost] = useState('');

  const filePath = configDir ? `${configDir}/network.json` : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dir = await configApi.getOmniConfigDir();
      setConfigDir(dir);
      const data = await configApi.readJsonFile(`${dir}/network.json`);
      if (data && typeof data === 'object') {
        const raw = data as Record<string, unknown>;
        const migrated = migrateConfig(raw);
        // Auto-save if the on-disk format is stale (e.g. allowedHosts instead of allowlist)
        // so the Python proxy runtime can read the correct keys.
        const needsMigration = 'allowedHosts' in raw || !('allowlist' in raw);
        if (needsMigration) {
          await configApi.writeJsonFile(`${dir}/network.json`, buildSavePayload(migrated));
        }
        setConfig(migrated);
      } else {
        const newConfig = emptyConfig();
        await configApi.writeJsonFile(`${dir}/network.json`, buildSavePayload(newConfig));
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
      await configApi.writeJsonFile(filePath, buildSavePayload(config));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [filePath, config]);

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
    return <FormSkeleton fields={4} />;
  }

  return (
    <div className={styles.root}>
      <SectionLabel>Network Isolation</SectionLabel>

      <Card className={styles.cardGap4}>
        <FormField label="Enable network isolation">
          <Switch checked={config.enabled} onCheckedChange={onToggleEnabled} />
        </FormField>

        <p className={styles.description}>
          When enabled, outbound network traffic is restricted to the hosts listed below in both chat and sandbox modes.
          All other traffic is blocked. Hosts can be domain names, IP addresses, or CIDR ranges.
        </p>

        {config.enabled && (
          <>
            <div className={styles.colGap2}>
              <span className={styles.subLabel}>Presets</span>
              <div className={styles.colGap2}>
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

            <div className={styles.colGap2}>
              <span className={styles.subLabel}>Additional allowed hosts</span>
              <div className={styles.colGap1}>
                {config.allowlist.map((host, i) => (
                  <HostRow key={i} host={host} index={i} onRemove={removeHost} />
                ))}
              </div>
              <div className={styles.rowGap2}>
                <Input
                  type="text"
                  value={newHost}
                  onChange={onChangeNewHost}
                  onKeyDown={onNewHostKeyDown}
                  placeholder="example.openai.azure.com or 10.0.0.0/16"
                  mono
                  className={styles.flex1}
                />
                <Button size="sm" variant="ghost" onClick={addHost} isDisabled={!newHost.trim()}>
                  <Add20Regular className={styles.iconMr} />
                  Add host
                </Button>
              </div>
            </div>

            <div className={styles.colGap2}>
              <span className={styles.subLabel}>Denied hosts</span>
              <p className={styles.description}>
                Explicitly blocked hosts. Denied hosts take precedence over allowed hosts.
              </p>
              <div className={styles.colGap1}>
                {config.denylist.map((host, i) => (
                  <HostRow key={i} host={host} index={i} onRemove={removeDenyHost} />
                ))}
              </div>
              <div className={styles.rowGap2}>
                <Input
                  type="text"
                  value={newDenyHost}
                  onChange={onChangeNewDenyHost}
                  onKeyDown={onNewDenyHostKeyDown}
                  placeholder="blocked.example.com"
                  mono
                  className={styles.flex1}
                />
                <Button size="sm" variant="ghost" onClick={addDenyHost} isDisabled={!newDenyHost.trim()}>
                  <Add20Regular className={styles.iconMr} />
                  Add denied host
                </Button>
              </div>
            </div>

            <FormField label="Allow private IP ranges (10.x, 172.16.x, 192.168.x)">
              <Switch checked={config.allow_private_ips} onCheckedChange={onToggleAllowPrivateIps} />
            </FormField>

            {effectiveHosts.length > 0 && (
              <div className={styles.colGap1}>
                <span className={styles.subLabel}>Effective allowlist</span>
                <p className={styles.effectiveMono}>{effectiveHosts.join(', ')}</p>
              </div>
            )}
          </>
        )}
      </Card>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
    </div>
  );
});
SettingsModalNetworkTab.displayName = 'SettingsModalNetworkTab';

const PresetRow = memo(
  ({ preset, checked, onToggle }: { preset: Preset; checked: boolean; onToggle: (id: string) => void }) => {
    const styles = useStyles();
    const onChange = useCallback(() => onToggle(preset.id), [preset.id, onToggle]);

    return (
      <label className={styles.presetLabel}>
        <Checkbox checked={checked} onCheckedChange={onChange} />
        <div className={styles.presetCol}>
          <span className={styles.presetName}>{preset.label}</span>
          <span className={styles.presetDesc}>{preset.description}</span>
        </div>
      </label>
    );
  }
);
PresetRow.displayName = 'PresetRow';

const HostRow = memo(
  ({ host, index, onRemove }: { host: string; index: number; onRemove: (index: number) => void }) => {
    const styles = useStyles();
    const onClickRemove = useCallback(() => onRemove(index), [index, onRemove]);

    return (
      <div className={styles.rowGap2}>
        <span className={styles.hostChip}>
          {host}
        </span>
        <IconButton aria-label="Remove host" icon={<Delete20Regular />} size="sm" onClick={onClickRemove} />
      </div>
    );
  }
);
HostRow.displayName = 'HostRow';
