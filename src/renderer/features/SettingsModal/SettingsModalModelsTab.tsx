import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';

import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Button, Card, Checkbox, FormField, FormSkeleton, IconButton, Input, SaveBar, SectionLabel, Select, Spinner } from '@/renderer/ds';
import { configApi } from '@/renderer/services/config';
import type { ModelEntry, ModelsConfig, ProviderEntry } from '@/shared/types';

const PROVIDER_TYPES: ProviderEntry['type'][] = ['openai', 'azure', 'openai-compatible', 'litellm'];
const REASONING_OPTIONS = ['none', 'low', 'medium', 'high'] as const;

function emptyConfig(): ModelsConfig {
  return { version: 3, default: null, voice_default: null, providers: {} };
}

function emptyProvider(): ProviderEntry {
  return { type: 'openai', models: {} };
}

function emptyModel(id: string): ModelEntry {
  return { model: id };
}

/** Collect all "provider/model" keys for default dropdowns */
function collectModelKeys(config: ModelsConfig): string[] {
  const keys: string[] = [];
  for (const [provName, prov] of Object.entries(config.providers)) {
    for (const modelId of Object.keys(prov.models)) {
      keys.push(`${provName}/${modelId}`);
    }
  }
  return keys;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  sectionLabelSpaced: { marginTop: tokens.spacingVerticalS },
  addRow: {
    padding: tokens.spacingVerticalL,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  flex1: { flex: '1 1 0' },
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
  colGap1: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  rowGap2: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
  modelCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    opacity: 0.8,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  modelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '10px',
    paddingBottom: '10px',
    '@media (min-width: 640px)': {
      paddingTop: tokens.spacingVerticalS,
      paddingBottom: tokens.spacingVerticalS,
    },
  },
  modelId: {
    fontSize: tokens.fontSizeBase300,
    fontFamily: 'monospace',
    color: tokens.colorNeutralForeground1,
    flex: '1 1 0',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  modelLabel: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  modelEditBody: {
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
    paddingTop: tokens.spacingVerticalS,
  },
});

export const SettingsModalModelsTab = memo(() => {
  const styles = useStyles();
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [config, setConfig] = useState<ModelsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [newProviderName, setNewProviderName] = useState('');
  const [newModelId, setNewModelId] = useState('');

  const filePath = configDir ? `${configDir}/models.json` : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dir = await configApi.getOmniConfigDir();
      setConfigDir(dir);
      const data = await configApi.readJsonFile(`${dir}/models.json`);
      if (data && typeof data === 'object' && 'version' in data) {
        setConfig(data as ModelsConfig);
      } else {
        const newConfig = emptyConfig();
        await configApi.writeJsonFile(`${dir}/models.json`, newConfig);
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

  const modelKeys = useMemo(() => (config ? collectModelKeys(config) : []), [config]);

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

  const updateConfig = useCallback((updater: (prev: ModelsConfig) => ModelsConfig) => {
    setConfig((prev) => {
      if (!prev) {
        return prev;
      }
      return updater(prev);
    });
    setDirty(true);
  }, []);

  const onChangeDefault = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      updateConfig((c) => ({ ...c, default: e.target.value || null }));
    },
    [updateConfig]
  );

  const onChangeVoiceDefault = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      updateConfig((c) => ({ ...c, voice_default: e.target.value || null }));
    },
    [updateConfig]
  );

  const addProvider = useCallback(() => {
    const name = newProviderName.trim();
    if (!name) {
      return;
    }
    updateConfig((c) => ({
      ...c,
      providers: { ...c.providers, [name]: emptyProvider() },
    }));
    setExpandedProvider(name);
    setNewProviderName('');
  }, [newProviderName, updateConfig]);

  const removeProvider = useCallback(
    (name: string) => {
      updateConfig((c) => {
        const { [name]: _, ...rest } = c.providers;
        return { ...c, providers: rest };
      });
      if (expandedProvider === name) {
        setExpandedProvider(null);
      }
    },
    [expandedProvider, updateConfig]
  );

  const updateProvider = useCallback(
    (name: string, field: string, value: string) => {
      updateConfig((c) => {
        const prov = c.providers[name];
        if (!prov) {
          return c;
        }
        return {
          ...c,
          providers: {
            ...c.providers,
            [name]: { ...prov, [field]: value || undefined },
          },
        };
      });
    },
    [updateConfig]
  );

  const addModel = useCallback(
    (providerName: string) => {
      const id = newModelId.trim();
      if (!id) {
        return;
      }
      updateConfig((c) => {
        const prov = c.providers[providerName];
        if (!prov) {
          return c;
        }
        return {
          ...c,
          providers: {
            ...c.providers,
            [providerName]: {
              ...prov,
              models: { ...prov.models, [id]: emptyModel(id) },
            },
          },
        };
      });
      setEditingModel({ provider: providerName, modelId: id });
      setNewModelId('');
    },
    [newModelId, updateConfig]
  );

  const removeModel = useCallback(
    (providerName: string, modelId: string) => {
      updateConfig((c) => {
        const prov = c.providers[providerName];
        if (!prov) {
          return c;
        }
        const { [modelId]: _, ...restModels } = prov.models;
        return {
          ...c,
          providers: {
            ...c.providers,
            [providerName]: { ...prov, models: restModels },
          },
        };
      });
      if (editingModel?.provider === providerName && editingModel.modelId === modelId) {
        setEditingModel(null);
      }
    },
    [editingModel, updateConfig]
  );

  const updateModel = useCallback(
    (providerName: string, modelId: string, field: string, value: unknown) => {
      updateConfig((c) => {
        const prov = c.providers[providerName];
        if (!prov) {
          return c;
        }
        const model = prov.models[modelId];
        if (!model) {
          return c;
        }
        return {
          ...c,
          providers: {
            ...c.providers,
            [providerName]: {
              ...prov,
              models: {
                ...prov.models,
                [modelId]: { ...model, [field]: value === '' ? undefined : value },
              },
            },
          },
        };
      });
    },
    [updateConfig]
  );

  const toggleEditModel = useCallback((provider: string, modelId: string) => {
    setEditingModel((prev) => (prev?.provider === provider && prev.modelId === modelId ? null : { provider, modelId }));
  }, []);

  const onChangeNewProviderName = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewProviderName(e.target.value);
  }, []);

  const onChangeNewModelId = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewModelId(e.target.value);
  }, []);

  if (loading || !config) {
    return <FormSkeleton fields={5} />;
  }

  return (
    <div className={styles.root}>
      <SectionLabel>Defaults</SectionLabel>
      <Card>
        <FormField label="Default model">
          <Select value={config.default ?? ''} onChange={onChangeDefault}>
            <option value="">None</option>
            {modelKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Voice model">
          <Select value={config.voice_default ?? ''} onChange={onChangeVoiceDefault}>
            <option value="">None</option>
            {modelKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </FormField>
      </Card>

      <SectionLabel className={styles.sectionLabelSpaced}>Providers</SectionLabel>
      <Accordion collapsible onToggle={(_e, data) => {
        setExpandedProvider(data.openItems.length > 0 ? String(data.openItems[data.openItems.length - 1]) : null);
        setEditingModel(null);
      }} openItems={expandedProvider ? [expandedProvider] : []}>
        {Object.entries(config.providers).map(([name, provider]) => (
          <ProviderRow
            key={name}
            name={name}
            provider={provider}
            editingModel={editingModel}
            newModelId={newModelId}
            onRemove={removeProvider}
            onUpdateProvider={updateProvider}
            onAddModel={addModel}
            onRemoveModel={removeModel}
            onUpdateModel={updateModel}
            onToggleEditModel={toggleEditModel}
            onChangeNewModelId={onChangeNewModelId}
          />
        ))}
      </Accordion>
      <div className={styles.addRow}>
        <Input
          type="text"
          value={newProviderName}
          onChange={onChangeNewProviderName}
          placeholder="Provider name"
          mono
          className={styles.flex1}
        />
        <Button size="sm" variant="ghost" onClick={addProvider} isDisabled={!newProviderName.trim()}>
          <Add20Regular className={styles.iconMr} />
          Add provider
        </Button>
      </div>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
    </div>
  );
});
SettingsModalModelsTab.displayName = 'SettingsModalModelsTab';

const ProviderRow = memo(
  ({
    name,
    provider,
    editingModel,
    newModelId,
    onRemove,
    onUpdateProvider,
    onAddModel,
    onRemoveModel,
    onUpdateModel,
    onToggleEditModel,
    onChangeNewModelId,
  }: {
    name: string;
    provider: ProviderEntry;
    editingModel: { provider: string; modelId: string } | null;
    newModelId: string;
    onRemove: (name: string) => void;
    onUpdateProvider: (name: string, field: string, value: string) => void;
    onAddModel: (providerName: string) => void;
    onRemoveModel: (providerName: string, modelId: string) => void;
    onUpdateModel: (providerName: string, modelId: string, field: string, value: unknown) => void;
    onToggleEditModel: (provider: string, modelId: string) => void;
    onChangeNewModelId: (e: ChangeEvent<HTMLInputElement>) => void;
  }) => {
    const styles = useStyles();
    const modelCount = Object.keys(provider.models).length;
    const showBaseUrl =
      provider.type === 'azure' || provider.type === 'openai-compatible' || provider.type === 'litellm';
    const showApiVersion = provider.type === 'azure';

    const onClickRemove = useCallback(() => {
      onRemove(name);
    }, [name, onRemove]);

    const onChangeType = useCallback(
      (e: ChangeEvent<HTMLSelectElement>) => onUpdateProvider(name, 'type', e.target.value),
      [name, onUpdateProvider]
    );
    const onChangeApiKey = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onUpdateProvider(name, 'api_key', e.target.value),
      [name, onUpdateProvider]
    );
    const onChangeBaseUrl = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onUpdateProvider(name, 'base_url', e.target.value),
      [name, onUpdateProvider]
    );
    const onChangeApiVersion = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onUpdateProvider(name, 'api_version', e.target.value),
      [name, onUpdateProvider]
    );
    const onClickAddModel = useCallback(() => onAddModel(name), [name, onAddModel]);

    return (
      <AccordionItem value={name}>
        <AccordionHeader expandIconPosition="end">
          <div className={styles.headerRow}>
            <div className={styles.headerContent}>
              <div className={styles.headerName}>{name}</div>
              <div className={styles.headerSummary}>
                Type: {provider.type} &middot; Models: {modelCount}
              </div>
            </div>
            <IconButton aria-label="Remove provider" icon={<Delete20Regular />} size="sm" onClick={onClickRemove} />
          </div>
        </AccordionHeader>
        <AccordionPanel>
          <div className={styles.panelBody}>
            <FormField label="Type">
              <Select value={provider.type} onChange={onChangeType}>
                {PROVIDER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="API Key">
              <Input
                type="text"
                value={provider.api_key ?? ''}
                onChange={onChangeApiKey}
                placeholder="sk-..."
                mono
                className={styles.flex1}
              />
            </FormField>
            {showBaseUrl && (
              <FormField label="Base URL">
                <Input
                  type="text"
                  value={provider.base_url ?? ''}
                  onChange={onChangeBaseUrl}
                  placeholder="https://..."
                  mono
                  className={styles.flex1}
                />
              </FormField>
            )}
            {showApiVersion && (
              <FormField label="API Version">
                <Input
                  type="text"
                  value={provider.api_version ?? ''}
                  onChange={onChangeApiVersion}
                  placeholder="2024-02-01"
                  mono
                  className={styles.flex1}
                />
              </FormField>
            )}

            <SectionLabel className={styles.sectionLabelSpaced}>Models</SectionLabel>
            <div className={styles.colGap1}>
              {Object.entries(provider.models).map(([modelId, model]) => {
                const isEditing = editingModel?.provider === name && editingModel.modelId === modelId;
                return (
                  <ModelRow
                    key={modelId}
                    providerName={name}
                    modelId={modelId}
                    model={model}
                    isEditing={isEditing}
                    onToggleEdit={onToggleEditModel}
                    onRemove={onRemoveModel}
                    onUpdate={onUpdateModel}
                  />
                );
              })}
            </div>

            <div className={styles.rowGap2}>
              <Input
                type="text"
                value={newModelId}
                onChange={onChangeNewModelId}
                placeholder="Model ID"
                mono
                className={styles.flex1}
              />
              <Button size="sm" variant="ghost" onClick={onClickAddModel} isDisabled={!newModelId.trim()}>
                <Add20Regular className={styles.iconMr} />
                Add model
              </Button>
            </div>
          </div>
        </AccordionPanel>
      </AccordionItem>
    );
  }
);
ProviderRow.displayName = 'ProviderRow';

const ModelRow = memo(
  ({
    providerName,
    modelId,
    model,
    isEditing,
    onToggleEdit,
    onRemove,
    onUpdate,
  }: {
    providerName: string;
    modelId: string;
    model: ModelEntry;
    isEditing: boolean;
    onToggleEdit: (provider: string, modelId: string) => void;
    onRemove: (providerName: string, modelId: string) => void;
    onUpdate: (providerName: string, modelId: string, field: string, value: unknown) => void;
  }) => {
    const styles = useStyles();
    const onClickToggle = useCallback(() => onToggleEdit(providerName, modelId), [providerName, modelId, onToggleEdit]);
    const onClickRemove = useCallback(() => onRemove(providerName, modelId), [providerName, modelId, onRemove]);

    const onChangeLabel = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onUpdate(providerName, modelId, 'label', e.target.value),
      [providerName, modelId, onUpdate]
    );
    const onChangeMaxInput = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value ? Number(e.target.value) : undefined;
        onUpdate(providerName, modelId, 'max_input_tokens', val);
      },
      [providerName, modelId, onUpdate]
    );
    const onChangeMaxOutput = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value ? Number(e.target.value) : undefined;
        onUpdate(providerName, modelId, 'max_output_tokens', val);
      },
      [providerName, modelId, onUpdate]
    );
    const onChangeReasoning = useCallback(
      (e: ChangeEvent<HTMLSelectElement>) => {
        onUpdate(providerName, modelId, 'reasoning', e.target.value === 'none' ? undefined : e.target.value);
      },
      [providerName, modelId, onUpdate]
    );
    const onChangeRealtime = useCallback(
      (checked: boolean) => {
        onUpdate(providerName, modelId, 'realtime', checked || undefined);
      },
      [providerName, modelId, onUpdate]
    );

    const storeValue = (model.model_settings as Record<string, unknown> | undefined)?.store !== false;
    const extraBody = (model.model_settings as Record<string, unknown> | undefined)?.extra_body as
      | Record<string, unknown>
      | undefined;
    const includeArr = Array.isArray(extraBody?.include) ? (extraBody.include as string[]) : [];
    const hasEncryptedReasoning = includeArr.includes('reasoning.encrypted_content');

    const onChangeStore = useCallback(
      (checked: boolean) => {
        const prev = (model.model_settings ?? {}) as Record<string, unknown>;
        // Checkbox label is "Disable storage" — checked means store: false
        const next = checked ? { ...prev, store: false } : { ...prev };
        // Clean up: remove store key when re-enabling (default is true)
        if (!checked) {
          delete next.store;
        }
        onUpdate(providerName, modelId, 'model_settings', Object.keys(next).length > 0 ? next : undefined);
      },
      [providerName, modelId, model.model_settings, onUpdate]
    );

    const onChangeEncryptedReasoning = useCallback(
      (checked: boolean) => {
        const prev = (model.model_settings ?? {}) as Record<string, unknown>;
        const prevExtra = (prev.extra_body ?? {}) as Record<string, unknown>;
        const prevInclude = Array.isArray(prevExtra.include) ? (prevExtra.include as string[]) : [];

        let nextInclude: string[];
        if (checked) {
          nextInclude = [...prevInclude, 'reasoning.encrypted_content'];
        } else {
          nextInclude = prevInclude.filter((v) => v !== 'reasoning.encrypted_content');
        }

        const nextExtra = nextInclude.length > 0 ? { ...prevExtra, include: nextInclude } : undefined;
        const next = { ...prev, extra_body: nextExtra };
        if (next.extra_body === undefined) {
          delete next.extra_body;
        }
        onUpdate(providerName, modelId, 'model_settings', Object.keys(next).length > 0 ? next : undefined);
      },
      [providerName, modelId, model.model_settings, onUpdate]
    );

    return (
      <div className={styles.modelCard}>
        <div className={styles.modelHeader}>
          <span className={styles.modelId}>{modelId}</span>
          {model.label && <span className={styles.modelLabel}>&ldquo;{model.label}&rdquo;</span>}
          <Button size="sm" variant="ghost" onClick={onClickToggle}>
            {isEditing ? 'Done' : 'Edit'}
          </Button>
          <IconButton aria-label="Remove model" icon={<Delete20Regular />} size="sm" onClick={onClickRemove} />
        </div>
        {isEditing && (
          <div className={styles.modelEditBody}>
            <FormField label="Label">
              <Input
                size="sm"
                type="text"
                value={model.label ?? ''}
                onChange={onChangeLabel}
                placeholder="Display label"
                className={styles.flex1}
              />
            </FormField>
            <FormField label="Max input tokens">
              <Input
                size="sm"
                type="number"
                value={model.max_input_tokens ?? ''}
                onChange={onChangeMaxInput}
                className={styles.flex1}
              />
            </FormField>
            <FormField label="Max output tokens">
              <Input
                size="sm"
                type="number"
                value={model.max_output_tokens ?? ''}
                onChange={onChangeMaxOutput}
                className={styles.flex1}
              />
            </FormField>
            <FormField label="Reasoning">
              <Select size="sm" value={model.reasoning ?? 'none'} onChange={onChangeReasoning}>
                {REASONING_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </FormField>
            <Checkbox checked={model.realtime ?? false} onCheckedChange={onChangeRealtime} label="Realtime model" />
            <Checkbox checked={!storeValue} onCheckedChange={onChangeStore} label="Disable storage (store: false)" />
            <Checkbox checked={hasEncryptedReasoning} onCheckedChange={onChangeEncryptedReasoning} label="Include encrypted reasoning content" />
          </div>
        )}
      </div>
    );
  }
);
ModelRow.displayName = 'ModelRow';
