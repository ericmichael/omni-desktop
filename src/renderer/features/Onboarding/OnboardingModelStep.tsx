import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
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
          <span className="text-sm font-semibold">Add a model</span>
          <span className="text-xs text-muted-foreground">
            Enter the model identifier and an optional display name.
          </span>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              Model ID <span className="text-destructive">*</span>
            </span>
            <Input value={modelId} onChange={handleModelIdChange} placeholder={modelIdPlaceholder} autoFocus />

            {providerType === 'litellm' && (
              <span className="text-xs text-muted-foreground">
                Use LiteLLM format: anthropic/claude-sonnet-4-20250514, gemini/gemini-2.5-pro, etc.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Display name</span>
            <Input
              value={displayName}
              onChange={handleDisplayNameChange}
              placeholder={modelId.split('/').pop() || 'My Model'}
            />
          </div>
        </div>

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="default" size="sm" onClick={onNext} disabled={!modelId.trim()}>
            Continue
          </Button>
        </div>
      </div>
    );
  }
);
OnboardingModelStep.displayName = 'OnboardingModelStep';
