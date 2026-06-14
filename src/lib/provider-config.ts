/**
 * Pure helpers that map identity-first provider answers ("I use Claude, here
 * is my key, I picked this model") onto the runtime's `ModelsConfig` v3
 * shape. This is the single place that knows `anthropic` rides the litellm
 * provider type and Ollama is an OpenAI-compatible server — the UI never
 * mentions either word outside Advanced.
 */
import type { ModelsConfig, ProviderEntry, ProviderProbe, RuntimeModelList } from '@/shared/types';

type ProviderSetupAnswers = {
  kind: 'openai' | 'anthropic' | 'ollama' | 'openai-compatible';
  apiKey?: string;
  baseUrl?: string;
  model: { id: string; label: string; maxInput: number; maxOutput: number };
  /** 'always' — onboarding (the user just chose this model). 'if-unset' —
   *  adding a provider alongside an existing setup. */
  makeDefault: 'always' | 'if-unset';
};

/** Provider-entry names the flows write. Stable so re-running merges instead of duplicating. */
const PROVIDER_NAMES: Record<ProviderSetupAnswers['kind'], string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  ollama: 'local',
  'openai-compatible': 'local',
};

/** Trim trailing slashes and ensure the OpenAI-compatible `/v1` suffix. */
export function normalizeCompatibleBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function buildProviderConfig(
  current: ModelsConfig,
  answers: ProviderSetupAnswers
): { config: ModelsConfig; modelRef: string } {
  const providerName = PROVIDER_NAMES[answers.kind];
  const modelKey = answers.model.id;
  const modelRef = `${providerName}/${modelKey}`;

  const existing = current.providers[providerName];
  const provider: ProviderEntry = existing
    ? { ...existing, models: { ...existing.models } }
    : {
        type: answers.kind === 'openai' ? 'openai' : answers.kind === 'anthropic' ? 'litellm' : 'openai-compatible',
        models: {},
      };

  if (answers.kind === 'openai') {
    provider.type = 'openai';
  } else if (answers.kind === 'anthropic') {
    provider.type = 'litellm';
  } else {
    provider.type = 'openai-compatible';
    provider.base_url = normalizeCompatibleBaseUrl(answers.baseUrl ?? '');
  }
  if (answers.apiKey?.trim()) {
    provider.api_key = answers.apiKey.trim();
  }

  provider.models[modelKey] = {
    // litellm routes by its own `provider/model` ref; native providers take the bare id.
    model: answers.kind === 'anthropic' ? `anthropic/${modelKey}` : modelKey,
    label: answers.model.label,
    max_input_tokens: answers.model.maxInput,
    max_output_tokens: answers.model.maxOutput,
    // `reasoning.encrypted_content` only exists on the OpenAI Responses API —
    // attaching it to litellm/compatible providers breaks requests.
    ...(answers.kind === 'openai'
      ? { model_settings: { store: false, extra_body: { include: ['reasoning.encrypted_content'] } } }
      : {}),
  };

  const config: ModelsConfig = {
    ...current,
    providers: { ...current.providers, [providerName]: provider },
    default: answers.makeDefault === 'always' ? modelRef : (current.default ?? modelRef),
  };

  return { config, modelRef };
}

/**
 * Merge a fresh ChatGPT (Codex) sign-in into the config: ensure the
 * `codex` openai-oauth provider exists (models stay empty — runtime
 * discovery fills them) and promote a Codex model to default when nothing
 * else is configured. Pure core of the Settings/onboarding sign-in flows.
 */
export function buildCodexConfig(
  current: ModelsConfig,
  runtime: RuntimeModelList | null
): { config: ModelsConfig; madeDefault: string | undefined } {
  const codexNames = (runtime?.models ?? [])
    .filter((m) => m.provider === 'openai-oauth' || m.name.startsWith('codex/'))
    .map((m) => m.name);
  const preferred = codexNames.find((n) => n.endsWith('/gpt-5.5')) ?? codexNames[0];

  const hasOtherProviders = Object.keys(current.providers).some((name) => name !== 'codex');
  const config: ModelsConfig = {
    ...current,
    providers: {
      ...current.providers,
      codex: current.providers.codex ?? { type: 'openai-oauth', models: {} },
    },
  };

  let madeDefault: string | undefined;
  if (!hasOtherProviders && preferred) {
    config.default = preferred;
    madeDefault = preferred;
  }
  return { config, madeDefault };
}

/**
 * Map a configured ProviderEntry to a health probe, or null when the entry
 * isn't probe-able (azure, generic litellm fan-out, OAuth — Codex health
 * comes from `codex:status` instead).
 */
export function probeForProvider(name: string, provider: ProviderEntry): ProviderProbe | null {
  if (provider.type === 'openai' && provider.api_key) {
    return { kind: 'openai', apiKey: provider.api_key };
  }
  if (provider.type === 'litellm' && provider.api_key && !provider.base_url) {
    const models = Object.values(provider.models);
    const isAnthropic =
      name === 'anthropic' || (models.length > 0 && models.every((m) => m.model.startsWith('anthropic/')));
    if (isAnthropic) {
      return { kind: 'anthropic', apiKey: provider.api_key };
    }
    return null;
  }
  if (provider.type === 'openai-compatible' && provider.base_url) {
    return {
      kind: 'openai-compatible',
      baseUrl: provider.base_url,
      ...(provider.api_key ? { apiKey: provider.api_key } : {}),
    };
  }
  return null;
}

/** `sk-…abc4` — enough to recognize a key, never enough to leak one. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return '••••';
  }
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

const AUTH_ERROR_PATTERN =
  /\b401\b|\b403\b|unauthorized|invalid[ _-]?(?:api[ _-]?)?key|incorrect api key|authentication[ _-]?error|x-api-key|api key not valid/i;

/**
 * Classify an agent/session error message. `auth` failures get the
 * "Check AI settings" fix-it path in the session banner.
 */
export function classifyAgentError(message: string): 'auth' | null {
  return AUTH_ERROR_PATTERN.test(message) ? 'auth' : null;
}
