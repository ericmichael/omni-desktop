import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds';
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

const INPUT_CLASS =
  'h-9 w-full px-3 text-sm rounded-md bg-transparent border border-surface-border/50 text-fg font-mono outline-none focus:border-accent-500/50 placeholder:text-fg-muted/50';

export const OnboardingModelStep = memo(
  ({ providerType, modelId, displayName, onChangeModelId, onChangeDisplayName, onNext, onBack }: Props) => {
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
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold text-fg">Add a model</h3>
          <p className="text-sm text-fg-muted">Enter the model identifier and an optional display name.</p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-fg" htmlFor="onboarding-model-id">
              Model ID <span className="text-red-400">*</span>
            </label>
            <input
              id="onboarding-model-id"
              type="text"
              value={modelId}
              onChange={handleModelIdChange}
              placeholder={modelIdPlaceholder}
              className={INPUT_CLASS}
              autoFocus
            />
            {providerType === 'litellm' && (
              <span className="text-xs text-fg-muted">
                Use LiteLLM format: anthropic/claude-sonnet-4-20250514, gemini/gemini-2.5-pro, etc.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-fg" htmlFor="onboarding-display-name">
              Display name
            </label>
            <input
              id="onboarding-display-name"
              type="text"
              value={displayName}
              onChange={handleDisplayNameChange}
              placeholder={modelId.split('/').pop() || 'My Model'}
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <div className="flex justify-between">
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
