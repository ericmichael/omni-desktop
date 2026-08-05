import { memo } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { RadioGroup, RadioGroupItem } from '@/renderer/ds/ui/radio-group';
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
  onBack?: (() => void) | undefined;
};

export const OnboardingProviderTypeStep = memo(({ selected, onSelect, onNext, onBack }: Props) => {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Choose a provider</span>
        <span className="text-xs text-muted-foreground">
          Omni works with any major model API. Pick where your models live — keys stay on this machine.
        </span>
      </div>

      <RadioGroup value={selected ?? ''} onValueChange={(value) => onSelect(value as ProviderEntry['type'])}>
        {PROVIDER_OPTIONS.map((option) => (
          <label key={option.value} className="inline-flex items-center gap-2 text-sm">
            <RadioGroupItem value={option.value} />
            <div>
              <span className="text-sm font-semibold">{option.label}</span>
              <span className="text-xs text-muted-foreground block">{option.description}</span>
            </div>
          </label>
        ))}
      </RadioGroup>

      <div className={onBack ? 'flex justify-between' : 'flex justify-end'}>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        )}
        <Button variant="default" size="sm" onClick={onNext} disabled={!selected}>
          Continue
        </Button>
      </div>
    </div>
  );
});
OnboardingProviderTypeStep.displayName = 'OnboardingProviderTypeStep';
