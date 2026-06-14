/**
 * Curated model catalog for the identity-first provider flows (onboarding and
 * the AI settings tab). The catalog supplies human labels, one-line blurbs,
 * and real token limits for the models we want everyday users to see; the
 * live provider listing (from `util:validate-provider`) filters it so stale
 * entries disappear on their own.
 *
 * Maintained by hand. Staleness degrades gracefully: an id missing from the
 * live list is dropped, and unknown live ids are still reachable through the
 * "More models" disclosure.
 */

type CatalogModel = {
  /** Provider-native model id (for Anthropic this is the bare id, without the litellm prefix). */
  id: string;
  label: string;
  blurb: string;
  recommended?: boolean;
  maxInput: number;
  maxOutput: number;
};

/** Fallback limits for models we know nothing about. */
export const DEFAULT_MAX_INPUT_TOKENS = 272000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 128000;

export const CATALOG: Record<'openai' | 'anthropic', CatalogModel[]> = {
  openai: [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      blurb: 'Best for everyday use',
      recommended: true,
      maxInput: 272000,
      maxOutput: 128000,
    },
    {
      id: 'gpt-5.5-codex',
      label: 'GPT-5.5 Codex',
      blurb: 'Tuned for coding and agents',
      maxInput: 272000,
      maxOutput: 128000,
    },
    {
      id: 'gpt-5.1',
      label: 'GPT-5.1',
      blurb: 'Previous generation, lower cost',
      maxInput: 272000,
      maxOutput: 128000,
    },
    {
      id: 'gpt-5.1-mini',
      label: 'GPT-5.1 mini',
      blurb: 'Fast and inexpensive',
      maxInput: 272000,
      maxOutput: 128000,
    },
  ],
  anthropic: [
    {
      id: 'claude-fable-5',
      label: 'Claude Fable 5',
      blurb: 'Best for everyday use',
      recommended: true,
      maxInput: 200000,
      maxOutput: 64000,
    },
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      blurb: 'Deep reasoning and long tasks',
      maxInput: 200000,
      maxOutput: 64000,
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      blurb: 'Balanced speed and capability',
      maxInput: 200000,
      maxOutput: 64000,
    },
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      blurb: 'Fast and inexpensive',
      maxInput: 200000,
      maxOutput: 64000,
    },
  ],
};

export type ModelChoice = CatalogModel & {
  /** False when the live listing couldn't be fetched and the entry is curated-only. */
  verified: boolean;
};

/**
 * Resolve the choices to present for a provider.
 *
 * - `openai` / `anthropic`: curated∩live, curated order and labels win. An
 *   empty live list (offline validation, proxy without listing) falls back to
 *   the full curated list flagged `verified: false`.
 * - `openai-compatible` / `ollama`: no catalog — every live id becomes a
 *   choice with the id as its label, first entry recommended.
 */
export function resolveModelChoices(
  kind: 'openai' | 'anthropic' | 'openai-compatible' | 'ollama',
  liveIds: string[]
): ModelChoice[] {
  if (kind === 'openai' || kind === 'anthropic') {
    const curated = CATALOG[kind];
    if (liveIds.length === 0) {
      return curated.map((m) => ({ ...m, verified: false }));
    }
    const live = new Set(liveIds);
    const matched = curated.filter((m) => live.has(m.id));
    if (matched.length === 0) {
      // Listing succeeded but none of our curated ids exist (heavily
      // restricted org key, or the catalog has fully aged out). Surface the
      // live ids rather than a dead curated list.
      return liveIds.map((id, i) => ({
        id,
        label: id,
        blurb: '',
        ...(i === 0 ? { recommended: true } : {}),
        maxInput: DEFAULT_MAX_INPUT_TOKENS,
        maxOutput: DEFAULT_MAX_OUTPUT_TOKENS,
        verified: true,
      }));
    }
    return matched.map((m) => ({ ...m, verified: true }));
  }

  return liveIds.map((id, i) => ({
    id,
    label: id,
    blurb: '',
    ...(i === 0 ? { recommended: true } : {}),
    maxInput: DEFAULT_MAX_INPUT_TOKENS,
    maxOutput: DEFAULT_MAX_OUTPUT_TOKENS,
    verified: true,
  }));
}
