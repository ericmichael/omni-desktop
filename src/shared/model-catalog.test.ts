import { describe, expect, it } from 'vitest';

import { CATALOG, resolveModelChoices } from '@/shared/model-catalog';

describe('resolveModelChoices', () => {
  it('intersects curated with live ids, keeping curated order and labels', () => {
    const live = ['gpt-5.1-mini', 'gpt-5.5', 'some-internal-model'];
    const choices = resolveModelChoices('openai', live);
    expect(choices.map((c) => c.id)).toEqual(['gpt-5.5', 'gpt-5.1-mini']);
    expect(choices[0]?.label).toBe('GPT-5.5');
    expect(choices[0]?.recommended).toBe(true);
    expect(choices.every((c) => c.verified)).toBe(true);
  });

  it('falls back to the full curated list (unverified) when the live list is empty', () => {
    const choices = resolveModelChoices('anthropic', []);
    expect(choices.map((c) => c.id)).toEqual(CATALOG.anthropic.map((m) => m.id));
    expect(choices.every((c) => c.verified === false)).toBe(true);
  });

  it('surfaces live ids when nothing curated matches', () => {
    const choices = resolveModelChoices('openai', ['org-restricted-model']);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ id: 'org-restricted-model', recommended: true, verified: true });
  });

  it('passes live ids through for compatible/ollama kinds with the first recommended', () => {
    const choices = resolveModelChoices('ollama', ['llama3.1:8b', 'qwen3:14b']);
    expect(choices.map((c) => c.id)).toEqual(['llama3.1:8b', 'qwen3:14b']);
    expect(choices[0]?.recommended).toBe(true);
    expect(choices[1]?.recommended).toBeUndefined();
  });

  it('every curated entry is recommended exactly once per provider', () => {
    for (const models of Object.values(CATALOG)) {
      expect(models.filter((m) => m.recommended)).toHaveLength(1);
    }
  });
});
