import { makeStyles } from '@fluentui/react-components';
import { memo } from 'react';

import { Body1Strong, Button, Caption1, Radio, RadioGroup } from '@/renderer/ds';
import type { ProviderEntry } from '@/shared/types';

type ProviderOption = {
  value: ProviderEntry['type'];
  label: string;
  description: string;
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: 'openai', label: 'OpenAI', description: 'GPT-4o, GPT-5, o3 and other OpenAI models' },
  { value: 'openai-compatible', label: 'OpenAI-Compatible', description: 'Any provider with an OpenAI-compatible API (Ollama, vLLM, etc.)' },
  { value: 'litellm', label: 'LiteLLM', description: 'Anthropic, Google, Mistral and 100+ providers via LiteLLM' },
];

type Props = {
  selected: ProviderEntry['type'] | null;
  onSelect: (type: ProviderEntry['type']) => void;
  onNext: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '24px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  actions: { display: 'flex', justifyContent: 'flex-end' },
});

export const OnboardingProviderTypeStep = memo(({ selected, onSelect, onNext }: Props) => {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Choose a provider</Body1Strong>
        <Caption1>Select the AI provider you want to use with Omni.</Caption1>
      </div>

      <RadioGroup
        value={selected ?? ''}
        onChange={(_e, data) => onSelect(data.value as ProviderEntry['type'])}
      >
        {PROVIDER_OPTIONS.map((option) => (
          <Radio
            key={option.value}
            value={option.value}
            label={
              <div>
                <Body1Strong>{option.label}</Body1Strong>
                <Caption1 block>{option.description}</Caption1>
              </div>
            }
          />
        ))}
      </RadioGroup>

      <div className={styles.actions}>
        <Button variant="primary" size="sm" onClick={onNext} isDisabled={!selected}>
          Continue
        </Button>
      </div>
    </div>
  );
});
OnboardingProviderTypeStep.displayName = 'OnboardingProviderTypeStep';
