import { makeStyles, tokens } from '@fluentui/react-components';
import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Body1, Button, Caption1, Input } from '@/renderer/ds';
import type { ProviderEntry } from '@/shared/types';

type Props = {
  providerType: ProviderEntry['type'];
  modelId: string;
  displayName: string;
  onChangeModelId: (value: string) => void;
  onChangeDisplayName: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '24px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  fields: { display: 'flex', flexDirection: 'column', gap: '16px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  required: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: 'flex', justifyContent: 'space-between' },
});

export const OnboardingModelStep = memo(
  ({ providerType, modelId, displayName, onChangeModelId, onChangeDisplayName, onNext, onBack }: Props) => {
    const styles = useStyles();

    const handleModelIdChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onChangeModelId(e.target.value),
      [onChangeModelId]
    );

    const handleDisplayNameChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onChangeDisplayName(e.target.value),
      [onChangeDisplayName]
    );

    const modelIdPlaceholder =
      providerType === 'litellm'
        ? 'anthropic/claude-sonnet-4-20250514'
        : providerType === 'openai'
          ? 'gpt-4o'
          : 'model-name';

    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <Body1 weight="semibold">Add a model</Body1>
          <Caption1>Enter the model identifier and an optional display name.</Caption1>
        </div>

        <div className={styles.fields}>
          <div className={styles.field}>
            <Caption1>
              Model ID <span className={styles.required}>*</span>
            </Caption1>
            <Input
              size="sm"
              mono
              value={modelId}
              onChange={handleModelIdChange}
              placeholder={modelIdPlaceholder}
              autoFocus
            />
            {providerType === 'litellm' && (
              <Caption1>Use LiteLLM format: anthropic/claude-sonnet-4-20250514, gemini/gemini-2.5-pro, etc.</Caption1>
            )}
          </div>

          <div className={styles.field}>
            <Caption1>Display name</Caption1>
            <Input
              size="sm"
              value={displayName}
              onChange={handleDisplayNameChange}
              placeholder={modelId.split('/').pop() || 'My Model'}
            />
          </div>
        </div>

        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="primary" size="sm" onClick={onNext} isDisabled={!modelId.trim()}>
            Continue
          </Button>
        </div>
      </div>
    );
  }
);
OnboardingModelStep.displayName = 'OnboardingModelStep';
