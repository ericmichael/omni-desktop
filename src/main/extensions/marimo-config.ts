import { promises as fs } from 'fs';
import path from 'path';

import { getOmniConfigDir } from '@/main/util';
import type { ModelsConfig, ProviderEntry } from '@/shared/types';

/**
 * Marker comment that identifies a `.marimo.toml` written by the launcher.
 * We refuse to overwrite a file unless its first line is this marker — that
 * way a user's own marimo config in a project directory is left alone, and
 * we only manage files we created.
 */
const MARIMO_TOML_MARKER = '# omni-launcher: managed — edits will be overwritten on next notebook open';

/** Filename marimo searches up from cwd for. */
const MARIMO_TOML_FILENAME = '.marimo.toml';

const escapeToml = (value: string): string =>
  // Conservative TOML basic-string escaping: backslashes and double quotes.
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const tomlString = (value: string): string => `"${escapeToml(value)}"`;

type LauncherDefault = { providerKey: string; modelId: string; provider: ProviderEntry };

/** Parse `"providerKey/modelId"` and resolve the provider entry. Returns null if anything is missing. */
const resolveDefault = (config: ModelsConfig): LauncherDefault | null => {
  if (!config.default) {
return null;
}
  const slash = config.default.indexOf('/');
  if (slash <= 0) {
return null;
}
  const providerKey = config.default.slice(0, slash);
  const modelId = config.default.slice(slash + 1);
  const provider = config.providers[providerKey];
  if (!provider) {
return null;
}
  // Either the provider-level api_key or the model-level api_key counts as configured.
  const modelEntry = provider.models[modelId];
  const apiKey = modelEntry?.api_key ?? provider.api_key;
  if (!apiKey) {
return null;
}
  return { providerKey, modelId, provider };
};

/**
 * Translate the launcher's resolved-default model into a marimo TOML body.
 * Returns `null` when there's nothing to wire (no default model, or the
 * provider has no API key). Caller is responsible for writing the file.
 *
 * The body deliberately writes only the `[ai]` section so that any other
 * marimo settings the launcher manages elsewhere (display, runtime, …) can
 * be appended without having to round-trip through a TOML library.
 */
export const buildMarimoAiToml = (config: ModelsConfig): string | null => {
  const resolved = resolveDefault(config);
  if (!resolved) {
return null;
}

  const { provider, modelId } = resolved;
  const modelEntry = provider.models[modelId];
  const apiKey = modelEntry?.api_key ?? provider.api_key ?? '';
  const baseUrl = provider.base_url;
  const apiVersion = provider.api_version;

  // Decide which marimo provider section to populate. Azure is a real
  // separate protocol; everything else flows through marimo's OpenAI client
  // (with an optional custom base_url for compat endpoints / proxies).
  let providerSection: string;
  let qualifiedModel: string;
  if (provider.type === 'azure') {
    const lines = [`api_key = ${tomlString(apiKey)}`];
    if (baseUrl) {
lines.push(`base_url = ${tomlString(baseUrl)}`);
}
    if (apiVersion) {
lines.push(`api_version = ${tomlString(apiVersion)}`);
}
    providerSection = `[ai.azure]\n${lines.join('\n')}\n`;
    qualifiedModel = `azure/${modelId}`;
  } else {
    const lines = [`api_key = ${tomlString(apiKey)}`];
    if (baseUrl) {
lines.push(`base_url = ${tomlString(baseUrl)}`);
}
    providerSection = `[ai.open_ai]\n${lines.join('\n')}\n`;
    qualifiedModel = `openai/${modelId}`;
  }

  const modelsSection =
    '[ai.models]\n' +
    `chat_model = ${tomlString(qualifiedModel)}\n` +
    `edit_model = ${tomlString(qualifiedModel)}\n` +
    `autocomplete_model = ${tomlString(qualifiedModel)}\n`;

  return `${MARIMO_TOML_MARKER}\n\n${providerSection}\n${modelsSection}`;
};

/**
 * Read the launcher's `models.json` from the omni config dir. Returns null
 * if the file is missing or unparseable — callers treat that as "no AI
 * model configured" and skip writing the marimo config.
 */
export const loadLauncherModelsConfig = async (): Promise<ModelsConfig | null> => {
  const filePath = path.join(getOmniConfigDir(), 'models.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ModelsConfig;
  } catch {
    return null;
  }
};

/**
 * Idempotently write `<projectDir>/.marimo.toml` with the launcher's AI
 * config. Refuses to overwrite a file that lacks our marker — protects
 * any pre-existing user-authored marimo config in the project directory.
 *
 * Called from the `page:prepare-notebook` IPC just before marimo starts so
 * the running server picks it up on the very first read.
 */
export const writeMarimoAiConfig = async (projectDir: string): Promise<void> => {
  const models = await loadLauncherModelsConfig();
  if (!models) {
return;
}
  const body = buildMarimoAiToml(models);
  if (!body) {
return;
}

  const filePath = path.join(projectDir, MARIMO_TOML_FILENAME);
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (!existing.startsWith(MARIMO_TOML_MARKER)) {
      // User-authored file — leave it alone.
      return;
    }
  } catch {
    // File doesn't exist — fine, we'll create it.
  }
  await fs.writeFile(filePath, body, 'utf-8');
};
