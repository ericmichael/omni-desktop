import { useStore } from '@nanostores/react';
import { Plus, Trash2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { buildCodexConfig, probeForProvider } from '@/lib/provider-config';
import { SaveBar } from '@/renderer/ds/SaveBar';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/renderer/ds/ui/accordion';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/renderer/ds/ui/radio-group';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
import { Spinner } from '@/renderer/ds/ui/spinner';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { SettingsModalConnectionCards } from '@/renderer/features/SettingsModal/SettingsModalConnectionCards';
import { agentConfigApi } from '@/renderer/services/config';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import type {
  CodexDeviceCode,
  ModelEntry,
  ModelsConfig,
  ProviderEntry,
  ProviderProbeResult,
  RuntimeModelEntry,
} from '@/shared/types';

const PROVIDER_TYPES: ProviderEntry['type'][] = ['openai', 'azure', 'openai-compatible', 'litellm', 'openai-oauth'];
const REASONING_OPTIONS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

function emptyProvider(): ProviderEntry {
  return { type: 'openai', models: {} };
}

function emptyModel(id: string): ModelEntry {
  return { model: id };
}

/**
 * "provider/model" keys for the default-model dropdown. Realtime models are
 * excluded: they only speak the realtime protocol, so picking one as the chat
 * default breaks every text turn.
 */
function collectModelKeys(config: ModelsConfig): string[] {
  const keys: string[] = [];
  for (const [provName, prov] of Object.entries(config.providers)) {
    for (const [modelId, entry] of Object.entries(prov.models)) {
      if (!entry.realtime) {
        keys.push(`${provName}/${modelId}`);
      }
    }
  }
  return keys;
}

/**
 * "provider/model" keys flagged `realtime` — the only models a voice_default
 * may point at. The runtime refuses to build voice settings for anything
 * else, so offering the full model list here produces a setting that looks
 * saved but is silently ignored.
 */
function collectRealtimeModelKeys(config: ModelsConfig): string[] {
  const keys: string[] = [];
  for (const [provName, prov] of Object.entries(config.providers)) {
    for (const [modelId, entry] of Object.entries(prov.models)) {
      if (entry.realtime) {
        keys.push(`${provName}/${modelId}`);
      }
    }
  }
  return keys;
}

export const SettingsModalAiTab = memo(() => {
  const [config, setConfig] = useState<ModelsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [newProviderName, setNewProviderName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  // Live merged model list from the runtime (`omni model list --json`), which
  // includes models not in the store — notably OAuth-discovered Codex models.
  // Entries, not names — the `realtime` flag decides what the voice model
  // dropdown may offer, and dropping it here would strand voice on text models.
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelEntry[]>([]);
  const runtimeModelNames = useMemo(() => runtimeModels.map((m) => m.name), [runtimeModels]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConfig(await agentConfigApi.getModels());
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

  useEffect(() => {
    emitter
      .invoke('util:list-models')
      .then((res) => setRuntimeModels(res.models))
      .catch(() => setRuntimeModels([]));
  }, []);

  // Dead ChatGPT sessions must not render a plausible "discovered" model
  // list — while broken, discovery is failing and the runtime list is just
  // local seeds wearing a live costume.
  const [codexBroken, setCodexBroken] = useState(false);
  useEffect(() => {
    emitter
      .invoke('codex:status')
      .then((s) => setCodexBroken(Boolean(s.broken)))
      .catch(() => setCodexBroken(false));
  }, []);

  // Union of store-configured keys and the live runtime list, so discovered
  // models (e.g. Codex) are selectable as the default model. Realtime models
  // are filtered from both halves — they belong to the Voice row only.
  const modelKeys = useMemo(() => {
    const storeKeys = config ? collectModelKeys(config) : [];
    const runtimeKeys = runtimeModels.filter((m) => !m.realtime).map((m) => m.name);
    return Array.from(new Set([...storeKeys, ...runtimeKeys])).sort();
  }, [config, runtimeModels]);

  // Same union, narrowed to realtime-capable models — what Hosted voice may use.
  const realtimeModelKeys = useMemo(() => {
    const storeKeys = config ? collectRealtimeModelKeys(config) : [];
    const runtimeKeys = runtimeModels.filter((m) => m.realtime).map((m) => m.name);
    return Array.from(new Set([...storeKeys, ...runtimeKeys])).sort();
  }, [config, runtimeModels]);

  // Offering Hosted with nothing to point it at would write null and bounce
  // the radio back to Off. An already-set voice_default keeps it reachable.
  const hostedVoiceAvailable = realtimeModelKeys.length > 0 || (config?.voice_default ?? null) !== null;

  /**
   * Called after a successful ChatGPT sign-in. Registers the built-in `codex`
   * provider in the store (so the user never hand-adds it; models stay empty —
   * the runtime discovers them). Makes a Codex model the default ONLY when no
   * other provider is configured; otherwise the existing setup is left alone
   * and Codex is just available via the picker / `/model`. Returns the model
   * that became the default, or undefined if the default was left unchanged.
   */
  const applyCodexSignIn = useCallback(async (): Promise<string | undefined> => {
    const current = await agentConfigApi.getModels();
    const runtime = await emitter.invoke('util:list-models').catch(() => null);
    // Push the fresh discovery into state so the default picker and the
    // Codex provider row both reflect sign-in immediately (no modal reopen).
    setRuntimeModels(runtime?.models ?? []);
    const { config: next, madeDefault } = buildCodexConfig(current, runtime);
    await agentConfigApi.setModels(next);
    await load();
    return madeDefault;
  }, [load]);

  /**
   * Connection-card fix path: validate the replacement key first, persist it
   * only when it works, then reload so the cards re-derive from saved state.
   */
  const applyKeyFix = useCallback(
    async (providerName: string, apiKey: string): Promise<ProviderProbeResult> => {
      const current = await agentConfigApi.getModels();
      const prov = current.providers[providerName];
      if (!prov) {
        return { ok: false, code: 'unknown', detail: 'Provider no longer exists' };
      }
      const candidate: ProviderEntry = { ...prov, api_key: apiKey };
      const probe = probeForProvider(providerName, candidate);
      if (!probe) {
        return { ok: false, code: 'unknown', detail: 'This provider cannot be checked automatically' };
      }
      const result = await emitter.invoke('util:validate-provider', probe);
      if (!result.ok) {
        return result;
      }
      await agentConfigApi.setModels({
        ...current,
        providers: { ...current.providers, [providerName]: candidate },
      });
      await load();
      return result;
    },
    [load]
  );

  const save = useCallback(async () => {
    if (!config) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await agentConfigApi.setModels(config);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [config]);

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

  // Voice provider: Hosted is the models.json `voice_default` (cloud realtime);
  // Local is the launcher-side on-device stack (Parakeet + Pocket), persisted
  // separately. They're mutually exclusive.
  const localVoiceEnabled = useStore(persistedStoreApi.$atom).localVoiceEnabled;
  const localVoiceCapable = isLocalVoiceCapable();
  const onChangeVoiceProvider = useCallback(
    (value: string) => {
      void persistedStoreApi.setKey('localVoiceEnabled', value === 'local');
      updateConfig((c) => ({
        ...c,
        // Hosted needs a non-null model so the row stays selected; seed the
        // first realtime-capable one (user refines via the Model dropdown).
        // Off/Local clear it. Seeding from the full model list would pick a
        // text model, which the runtime then ignores.
        voice_default: value === 'hosted' ? (c.voice_default ?? realtimeModelKeys[0] ?? null) : null,
      }));
    },
    [updateConfig, realtimeModelKeys]
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
    (name: string, field: string, value: string | boolean | undefined) => {
      updateConfig((c) => {
        const prov = c.providers[name];
        if (!prov) {
          return c;
        }
        const nextValue = value === '' ? undefined : value;
        return {
          ...c,
          providers: {
            ...c.providers,
            [name]: { ...prov, [field]: nextValue },
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
    return (
      <div className="flex w-full flex-col gap-5 p-4">
        {Array.from({ length: 5 }, (_, index) => (
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
      <SettingsSection title="Connections">
        <CodexSignInCard onSignedIn={applyCodexSignIn} />
        <SettingsModalConnectionCards config={config} onFixKey={applyKeyFix} />
      </SettingsSection>

      <SettingsSection title="Defaults">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Default model</FieldLabel>
              </div>
              <Select value={config.default ?? ''} onChange={onChangeDefault}>
                <option value="">None</option>
                {modelKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Voice</FieldLabel>
              </div>
              <RadioGroup
                className="flex flex-wrap"
                value={localVoiceEnabled ? 'local' : config.voice_default ? 'hosted' : 'off'}
                onValueChange={onChangeVoiceProvider}
              >
                <label className="inline-flex items-center gap-2 text-sm">
                  <RadioGroupItem value="off" />
                  Off
                </label>
                <label
                  className="inline-flex items-center gap-2 text-sm"
                  title={
                    hostedVoiceAvailable ? undefined : 'No realtime model configured — sign in with ChatGPT or add one'
                  }
                >
                  <RadioGroupItem value="hosted" disabled={!hostedVoiceAvailable} />
                  Hosted
                </label>

                <label
                  className="inline-flex items-center gap-2 text-sm"
                  title={localVoiceCapable ? undefined : 'Not available in this deployment'}
                >
                  <RadioGroupItem value="local" disabled={!localVoiceCapable} />
                  Local
                </label>
              </RadioGroup>
            </Field>
            {!localVoiceEnabled && config.voice_default !== null ? (
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>Model</FieldLabel>
                </div>
                <Select value={config.voice_default ?? ''} onChange={onChangeVoiceDefault}>
                  <option value="">None</option>
                  {realtimeModelKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {localVoiceEnabled ? (
              <>
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Speech-to-text</FieldLabel>
                  </div>
                  <Select value="parakeet" disabled>
                    <option value="parakeet">Parakeet 0.6B</option>
                  </Select>
                </Field>
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Text-to-speech</FieldLabel>
                  </div>
                  <Select value="pocket" disabled>
                    <option value="pocket">Pocket</option>
                  </Select>
                </Field>
                <span className="text-xs text-muted-foreground">
                  Runs on this machine · models download on first use.
                </span>
              </>
            ) : null}
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection title="Advanced">
        <Accordion type="single" collapsible>
          <AccordionItem value="advanced-editor">
            <AccordionTrigger>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">Providers and models</div>
                <div className="text-sm text-muted-foreground sm:text-xs">
                  Raw configuration — endpoints, token limits, reasoning effort
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <Accordion
                type="single"
                collapsible
                onValueChange={(value) => {
                  setExpandedProvider(value || null);
                  setEditingModel(null);
                }}
                value={expandedProvider ?? ''}
              >
                {Object.entries(config.providers).map(([name, provider]) => {
                  const prefix = `${name}/`;
                  const discoveredModels = runtimeModelNames
                    .filter((n) => n.startsWith(prefix))
                    .map((n) => n.slice(prefix.length));
                  return (
                    <ProviderRow
                      key={name}
                      name={name}
                      provider={provider}
                      discoveredModels={discoveredModels}
                      codexBroken={codexBroken}
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
                  );
                })}
              </Accordion>
              <div className="p-5 flex items-center gap-2">
                <Input
                  type="text"
                  value={newProviderName}
                  onChange={onChangeNewProviderName}
                  placeholder="Provider name"
                  className="flex-1"
                />

                <Button size="sm" variant="ghost" onClick={addProvider} disabled={!newProviderName.trim()}>
                  <Plus className="mr-1" />
                  Add provider
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SettingsSection>

      <SaveBar onSave={save} dirty={dirty} saving={saving} error={error} />
    </SettingsPane>
  );
});
SettingsModalAiTab.displayName = 'SettingsModalAiTab';

/**
 * Sign in to a ChatGPT subscription (Codex). Main runs the browser PKCE flow
 * and stores tokens in the omni-code config dir; the runtime refreshes them.
 *
 * Signing in is all the user should need: on success we make a discovered
 * Codex model the default (and register the built-in `codex` provider in the
 * store so it's visible), so the agent uses ChatGPT immediately — no manual
 * provider setup. `onSignedIn` does that and returns the chosen model ref.
 */
const CodexSignInCard = memo(({ onSignedIn }: { onSignedIn: () => Promise<string | undefined> }) => {
  const [status, setStatus] = useState<{ signedIn: boolean; accountId?: string; broken?: boolean } | null>(null);
  const [activeModel, setActiveModel] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set while the device-flow user_code is live and the user is authorizing.
  const [deviceCode, setDeviceCode] = useState<CodexDeviceCode | null>(null);

  useEffect(() => {
    emitter
      .invoke('codex:status')
      .then(setStatus)
      .catch(() => setStatus({ signedIn: false }));
  }, []);

  // Main pushes the user code mid-flow; show it while we poll.
  useEffect(() => ipc.on('codex:device-code', setDeviceCode), []);

  const onSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDeviceCode(null);
    try {
      // Device flow works in Electron and server/browser mode alike. PKCE
      // (codex:login) is still available in Electron for a one-click UX but
      // the device flow's universality wins for a single code path here.
      const next = await emitter.invoke('codex:link');
      setStatus(next);
      if (next.signedIn) {
        setActiveModel(await onSignedIn());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
      setDeviceCode(null);
    }
  }, [onSignedIn]);

  const onSignOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await emitter.invoke('codex:logout');
      setStatus({ signedIn: false });
      setActiveModel(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-out failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {status?.broken
                ? 'ChatGPT session expired'
                : status?.signedIn
                  ? 'Signed in to ChatGPT'
                  : 'Use your ChatGPT subscription'}
            </div>
            <div className="text-sm text-muted-foreground sm:text-xs">
              {status?.broken
                ? 'Sign in again to reconnect.'
                : status?.signedIn
                  ? (activeModel ?? '')
                  : (error ?? 'Works with Plus, Pro, and Team plans.')}
            </div>
          </div>
          {status?.signedIn && !status.broken ? (
            <Button size="sm" variant="ghost" onClick={onSignOut} disabled={busy}>
              Sign out
            </Button>
          ) : (
            <Button size="sm" onClick={onSignIn} disabled={busy}>
              {busy ? 'Waiting for authorization…' : status?.broken ? 'Sign in again' : 'Sign in with ChatGPT'}
            </Button>
          )}
        </div>

        {busy && deviceCode && (
          <div className="flex flex-col gap-0.5 p-2 rounded-lg bg-background border border-border">
            <span className="text-xs text-muted-foreground">
              Open{' '}
              <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
                {deviceCode.verificationUri}
              </a>{' '}
              and enter this code:
            </span>
            <span className="font-mono text-xl font-semibold tracking-widest">{deviceCode.userCode}</span>
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-xs text-muted-foreground">Waiting for authorization…</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
CodexSignInCard.displayName = 'CodexSignInCard';

const ProviderRow = memo(
  ({
    name,
    provider,
    discoveredModels,
    codexBroken,
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
    discoveredModels: string[];
    /** Dead ChatGPT session — suppress the "discovered" list (it's just seeds). */ codexBroken: boolean;
    editingModel: { provider: string; modelId: string } | null;
    newModelId: string;
    onRemove: (name: string) => void;
    onUpdateProvider: (name: string, field: string, value: string | boolean | undefined) => void;
    onAddModel: (providerName: string) => void;
    onRemoveModel: (providerName: string, modelId: string) => void;
    onUpdateModel: (providerName: string, modelId: string, field: string, value: unknown) => void;
    onToggleEditModel: (provider: string, modelId: string) => void;
    onChangeNewModelId: (e: ChangeEvent<HTMLInputElement>) => void;
  }) => {
    const storedCount = Object.keys(provider.models).length;
    const isOauth = provider.type === 'openai-oauth';
    // Show runtime-discovered models for OAuth providers (Codex) where the
    // store intentionally holds an empty `models: {}` and discovery fills it.
    // While the sign-in is broken, discovery is failing and the runtime list
    // is only local seeds — showing them as "discovered" would be a lie.
    const extraDiscovered = isOauth && !codexBroken ? discoveredModels.filter((id) => !(id in provider.models)) : [];
    const modelCount = storedCount + extraDiscovered.length;
    const showBaseUrl =
      provider.type === 'azure' || provider.type === 'openai-compatible' || provider.type === 'litellm';
    const showApiVersion = provider.type === 'azure';
    const showApiMode =
      provider.type === 'openai' || provider.type === 'openai-compatible' || provider.type === 'azure';
    // OAuth providers authenticate via the ChatGPT sign-in above, not a key.
    const showApiKey = !isOauth;

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
    const onChangeApiMode = useCallback(
      (e: ChangeEvent<HTMLSelectElement>) => {
        onUpdateProvider(name, 'use_responses', e.target.value === 'responses' ? undefined : false);
      },
      [name, onUpdateProvider]
    );
    const onClickAddModel = useCallback(() => onAddModel(name), [name, onAddModel]);

    return (
      <AccordionItem value={name}>
        <AccordionTrigger>
          <div className="flex items-center gap-2 w-full min-w-0">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">{name}</div>
              <div className="text-sm text-muted-foreground sm:text-xs">
                Type: {provider.type} &middot; Models: {modelCount}
              </div>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove provider" onClick={onClickRemove}>
              <Trash2 />
            </Button>
          </div>
        </AccordionTrigger>
        <AccordionContent>
          <div className="pl-5 pr-5 pb-5 flex flex-col gap-4">
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Type</FieldLabel>
              </div>
              <Select value={provider.type} onChange={onChangeType}>
                {PROVIDER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            {showApiKey && (
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>API Key</FieldLabel>
                </div>
                <Input
                  type="text"
                  value={provider.api_key ?? ''}
                  onChange={onChangeApiKey}
                  placeholder="sk-..."
                  className="flex-1"
                />
              </Field>
            )}
            {showBaseUrl && (
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>Base URL</FieldLabel>
                </div>
                <Input
                  type="text"
                  value={provider.base_url ?? ''}
                  onChange={onChangeBaseUrl}
                  placeholder="https://..."
                  className="flex-1"
                />
              </Field>
            )}
            {showApiVersion && (
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>API Version</FieldLabel>
                </div>
                <Input
                  type="text"
                  value={provider.api_version ?? ''}
                  onChange={onChangeApiVersion}
                  placeholder="2024-02-01"
                  className="flex-1"
                />
              </Field>
            )}
            {showApiMode && (
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>OpenAI API mode</FieldLabel>
                </div>
                <Select
                  value={provider.use_responses === false ? 'chat_completions' : 'responses'}
                  onChange={onChangeApiMode}
                >
                  <option value="responses">Responses API (recommended)</option>
                  <option value="chat_completions">Chat Completions API</option>
                </Select>
              </Field>
            )}

            <span className="mt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Models</span>
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
              {extraDiscovered.map((modelId) => (
                <div key={`discovered-${modelId}`} className="bg-background opacity-80 rounded-xl border border-border">
                  <div className="flex items-center gap-2 pl-4 pr-4 pt-2.5 pb-2.5 sm:pt-2 sm:pb-2">
                    <div className="text-sm font-mono text-foreground flex-1 sm:text-xs">{modelId}</div>
                    <div className="text-sm text-muted-foreground sm:text-xs">discovered from ChatGPT</div>
                  </div>
                </div>
              ))}
              {isOauth && codexBroken && (
                <div className="bg-background opacity-80 rounded-xl border border-border">
                  <div className="flex items-center gap-2 pl-4 pr-4 pt-2.5 pb-2.5 sm:pt-2 sm:pb-2">
                    <div className="text-sm text-muted-foreground sm:text-xs">
                      Sign-in expired — model list unavailable
                    </div>
                  </div>
                </div>
              )}
            </div>

            {!isOauth && (
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={newModelId}
                  onChange={onChangeNewModelId}
                  placeholder="Model ID"
                  className="flex-1"
                />

                <Button size="sm" variant="ghost" onClick={onClickAddModel} disabled={!newModelId.trim()}>
                  <Plus className="mr-1" />
                  Add model
                </Button>
              </div>
            )}
          </div>
        </AccordionContent>
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
      <div className="bg-background opacity-80 rounded-xl border border-border">
        <div className="flex items-center gap-2 pl-4 pr-4 pt-2.5 pb-2.5 sm:pt-2 sm:pb-2">
          <span className="text-sm font-mono text-foreground flex-1 sm:text-xs">{modelId}</span>
          {model.label && <span className="text-sm text-muted-foreground sm:text-xs">&ldquo;{model.label}&rdquo;</span>}
          <Button size="sm" variant="ghost" onClick={onClickToggle}>
            {isEditing ? 'Done' : 'Edit'}
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove model" onClick={onClickRemove}>
            <Trash2 />
          </Button>
        </div>
        {isEditing && (
          <div className="pl-4 pr-4 pb-4 flex flex-col gap-2 border-t border-border pt-2">
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Label</FieldLabel>
              </div>
              <Input
                type="text"
                value={model.label ?? ''}
                onChange={onChangeLabel}
                placeholder="Display label"
                className="flex-1"
              />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Max input tokens</FieldLabel>
              </div>
              <Input
                type="number"
                value={model.max_input_tokens?.toString() ?? ''}
                onChange={onChangeMaxInput}
                className="flex-1"
              />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Max output tokens</FieldLabel>
              </div>
              <Input
                type="number"
                value={model.max_output_tokens?.toString() ?? ''}
                onChange={onChangeMaxOutput}
                className="flex-1"
              />
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Reasoning</FieldLabel>
              </div>
              <Select value={model.reasoning ?? 'none'} onChange={onChangeReasoning}>
                {REASONING_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={model.realtime ?? false}
                onCheckedChange={(checked) => onChangeRealtime(checked === true)}
              />
              Realtime model
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox checked={!storeValue} onCheckedChange={(checked) => onChangeStore(checked === true)} />
              Disable storage (store: false)
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={hasEncryptedReasoning}
                onCheckedChange={(checked) => onChangeEncryptedReasoning(checked === true)}
              />
              Include encrypted reasoning content
            </label>
          </div>
        )}
      </div>
    );
  }
);
ModelRow.displayName = 'ModelRow';
