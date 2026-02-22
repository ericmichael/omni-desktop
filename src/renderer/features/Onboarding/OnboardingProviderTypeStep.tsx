import { motion } from 'framer-motion';
import { memo, useCallback } from 'react';

import { Button, cn } from '@/renderer/ds';
import type { ProviderEntry } from '@/shared/types';

type ProviderOption = {
  value: ProviderEntry['type'];
  label: string;
  description: string;
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: 'openai', label: 'OpenAI', description: 'GPT-4o, GPT-5, o3 and other OpenAI models' },
  {
    value: 'openai-compatible',
    label: 'OpenAI-Compatible',
    description: 'Any provider with an OpenAI-compatible API (Ollama, vLLM, etc.)',
  },
  { value: 'litellm', label: 'LiteLLM', description: 'Anthropic, Google, Mistral and 100+ providers via LiteLLM' },
];

type Props = {
  selected: ProviderEntry['type'] | null;
  onSelect: (type: ProviderEntry['type']) => void;
  onNext: () => void;
};

export const OnboardingProviderTypeStep = memo(({ selected, onSelect, onNext }: Props) => {
  const handleSelectOpenai = useCallback(() => onSelect('openai'), [onSelect]);
  const handleSelectCompatible = useCallback(() => onSelect('openai-compatible'), [onSelect]);
  const handleSelectLitellm = useCallback(() => onSelect('litellm'), [onSelect]);

  const handlers: Record<ProviderEntry['type'], () => void> = {
    openai: handleSelectOpenai,
    'openai-compatible': handleSelectCompatible,
    litellm: handleSelectLitellm,
    azure: handleSelectOpenai,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold text-fg">Choose a provider</h3>
        <p className="text-sm text-fg-muted">Select the AI provider you want to use with Omni.</p>
      </div>

      <div className="flex flex-col gap-3">
        {PROVIDER_OPTIONS.map((option) => (
          <motion.button
            key={option.value}
            type="button"
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            transition={{ duration: 0.15 }}
            onClick={handlers[option.value]}
            className={cn(
              'flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors',
              selected === option.value
                ? 'border-accent-500 bg-accent-500/10'
                : 'border-surface-border/50 bg-surface-raised/50 hover:border-surface-border'
            )}
          >
            <span className="text-sm font-medium text-fg">{option.label}</span>
            <span className="text-xs text-fg-muted">{option.description}</span>
          </motion.button>
        ))}
      </div>

      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={onNext} isDisabled={!selected}>
          Continue
        </Button>
      </div>
    </div>
  );
});
OnboardingProviderTypeStep.displayName = 'OnboardingProviderTypeStep';
