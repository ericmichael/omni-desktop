import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiCaretDownBold, PiCaretUpBold, PiPlusBold, PiTrashBold } from 'react-icons/pi';

import { Button, FormField, IconButton, Spinner } from '@/renderer/ds';
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

export const SettingsModalModelsTab = memo(() => {
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

  const modelKeys = useMemo(() => (config ? collectModelKeys(config) : []), [config]);

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

  const toggleProvider = useCallback((name: string) => {
    setExpandedProvider((prev) => (prev === name ? null : name));
    setEditingModel(null);
  }, []);

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
        <span className="text-sm text-fg-muted">No models.json found</span>
        <Button size="sm" variant="primary" onClick={createConfig} isDisabled={saving}>
          Create models.json
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Defaults</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Default model">
          <select
            value={config.default ?? ''}
            onChange={onChangeDefault}
            className="h-8 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
          >
            <option value="">None</option>
            {modelKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Voice model">
          <select
            value={config.voice_default ?? ''}
            onChange={onChangeVoiceDefault}
            className="h-8 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
          >
            <option value="">None</option>
            {modelKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Providers</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 divide-y divide-surface-border/50">
        {Object.entries(config.providers).map(([name, provider]) => (
          <ProviderRow
            key={name}
            name={name}
            provider={provider}
            isExpanded={expandedProvider === name}
            editingModel={editingModel}
            newModelId={newModelId}
            onToggle={toggleProvider}
            onRemove={removeProvider}
            onUpdateProvider={updateProvider}
            onAddModel={addModel}
            onRemoveModel={removeModel}
            onUpdateModel={updateModel}
            onToggleEditModel={toggleEditModel}
            onChangeNewModelId={onChangeNewModelId}
          />
        ))}
        <div className="p-4 flex items-center gap-2">
          <input
            type="text"
            value={newProviderName}
            onChange={onChangeNewProviderName}
            placeholder="Provider name"
            className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
          />
          <Button size="sm" variant="ghost" onClick={addProvider} isDisabled={!newProviderName.trim()}>
            <PiPlusBold className="mr-1" />
            Add provider
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
SettingsModalModelsTab.displayName = 'SettingsModalModelsTab';

const ProviderRow = memo(
  ({
    name,
    provider,
    isExpanded,
    editingModel,
    newModelId,
    onToggle,
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
    isExpanded: boolean;
    editingModel: { provider: string; modelId: string } | null;
    newModelId: string;
    onToggle: (name: string) => void;
    onRemove: (name: string) => void;
    onUpdateProvider: (name: string, field: string, value: string) => void;
    onAddModel: (providerName: string) => void;
    onRemoveModel: (providerName: string, modelId: string) => void;
    onUpdateModel: (providerName: string, modelId: string, field: string, value: unknown) => void;
    onToggleEditModel: (provider: string, modelId: string) => void;
    onChangeNewModelId: (e: ChangeEvent<HTMLInputElement>) => void;
  }) => {
    const modelCount = Object.keys(provider.models).length;
    const showBaseUrl =
      provider.type === 'azure' || provider.type === 'openai-compatible' || provider.type === 'litellm';
    const showApiVersion = provider.type === 'azure';

    const onClickToggle = useCallback(() => onToggle(name), [name, onToggle]);
    const onClickRemove = useCallback(() => onRemove(name), [name, onRemove]);

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
      <div className="flex flex-col">
        <div className="flex items-center gap-2 p-4 cursor-pointer" onClick={onClickToggle}>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-fg">{name}</div>
            <div className="text-xs text-fg-muted">
              Type: {provider.type} &middot; Models: {modelCount}
            </div>
          </div>
          {isExpanded ? (
            <PiCaretUpBold className="text-fg-muted text-xs" />
          ) : (
            <PiCaretDownBold className="text-fg-muted text-xs" />
          )}
          <IconButton aria-label="Remove provider" icon={<PiTrashBold />} size="sm" onClick={onClickRemove} />
        </div>

        {isExpanded && (
          <div className="px-4 pb-4 flex flex-col gap-3 border-t border-surface-border/30 pt-3">
            <FormField label="Type">
              <select
                value={provider.type}
                onChange={onChangeType}
                className="h-8 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
              >
                {PROVIDER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="API Key">
              <input
                type="text"
                value={provider.api_key ?? ''}
                onChange={onChangeApiKey}
                placeholder="sk-..."
                className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
              />
            </FormField>
            {showBaseUrl && (
              <FormField label="Base URL">
                <input
                  type="text"
                  value={provider.base_url ?? ''}
                  onChange={onChangeBaseUrl}
                  placeholder="https://..."
                  className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
                />
              </FormField>
            )}
            {showApiVersion && (
              <FormField label="API Version">
                <input
                  type="text"
                  value={provider.api_version ?? ''}
                  onChange={onChangeApiVersion}
                  placeholder="2024-02-01"
                  className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
                />
              </FormField>
            )}

            <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Models</span>
            <div className="flex flex-col gap-1">
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

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newModelId}
                onChange={onChangeNewModelId}
                placeholder="Model ID"
                className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg font-mono flex-1 outline-none focus:border-accent-500/50"
              />
              <Button size="sm" variant="ghost" onClick={onClickAddModel} isDisabled={!newModelId.trim()}>
                <PiPlusBold className="mr-1" />
                Add model
              </Button>
            </div>
          </div>
        )}
      </div>
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
      (e: ChangeEvent<HTMLInputElement>) => {
        onUpdate(providerName, modelId, 'realtime', e.target.checked || undefined);
      },
      [providerName, modelId, onUpdate]
    );

    return (
      <div className="bg-surface/50 rounded-md border border-surface-border/30">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-xs font-mono text-fg flex-1">{modelId}</span>
          {model.label && <span className="text-xs text-fg-muted">&ldquo;{model.label}&rdquo;</span>}
          <Button size="sm" variant="ghost" onClick={onClickToggle}>
            {isEditing ? 'Done' : 'Edit'}
          </Button>
          <IconButton aria-label="Remove model" icon={<PiTrashBold />} size="sm" onClick={onClickRemove} />
        </div>
        {isEditing && (
          <div className="px-3 pb-3 flex flex-col gap-2 border-t border-surface-border/30 pt-2">
            <FormField label="Label">
              <input
                type="text"
                value={model.label ?? ''}
                onChange={onChangeLabel}
                placeholder="Display label"
                className="h-7 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg flex-1 outline-none focus:border-accent-500/50"
              />
            </FormField>
            <FormField label="Max input tokens">
              <input
                type="number"
                value={model.max_input_tokens ?? ''}
                onChange={onChangeMaxInput}
                className="h-7 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg flex-1 outline-none focus:border-accent-500/50"
              />
            </FormField>
            <FormField label="Max output tokens">
              <input
                type="number"
                value={model.max_output_tokens ?? ''}
                onChange={onChangeMaxOutput}
                className="h-7 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg flex-1 outline-none focus:border-accent-500/50"
              />
            </FormField>
            <FormField label="Reasoning">
              <select
                value={model.reasoning ?? 'none'}
                onChange={onChangeReasoning}
                className="h-7 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
              >
                {REASONING_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </FormField>
            <label className="flex items-center gap-2 text-xs text-fg cursor-pointer">
              <input type="checkbox" checked={model.realtime ?? false} onChange={onChangeRealtime} />
              Realtime model
            </label>
          </div>
        )}
      </div>
    );
  }
);
ModelRow.displayName = 'ModelRow';
