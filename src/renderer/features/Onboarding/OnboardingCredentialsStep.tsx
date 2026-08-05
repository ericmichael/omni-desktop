import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
import type { ProviderEntry } from '@/shared/types';

type Props = {
  providerType: ProviderEntry['type'];
  apiKey: string;
  baseUrl: string;
  onChangeApiKey: (value: string) => void;
  onChangeBaseUrl: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
};

export const OnboardingCredentialsStep = memo(
  ({ providerType, apiKey, baseUrl, onChangeApiKey, onChangeBaseUrl, onNext, onBack }: Props) => {
    const showBaseUrl = providerType === 'openai-compatible' || providerType === 'litellm';
    const apiKeyRequired = providerType !== 'openai-compatible';
    const baseUrlRequired = providerType === 'openai-compatible';

    const canContinue = apiKeyRequired ? apiKey.trim().length > 0 : baseUrlRequired ? baseUrl.trim().length > 0 : true;

    const handleApiKeyChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onChangeApiKey(e.target.value),
      [onChangeApiKey]
    );

    const handleBaseUrlChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => onChangeBaseUrl(e.target.value),
      [onChangeBaseUrl]
    );

    const apiKeyPlaceholder =
      providerType === 'openai'
        ? 'sk-...'
        : providerType === 'litellm'
          ? 'API key for the selected provider'
          : 'API key (optional for local)';

    const baseUrlPlaceholder =
      providerType === 'openai-compatible' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1';

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">Enter credentials</span>
          <span className="text-xs text-muted-foreground">
            {providerType === 'openai' && 'Enter your OpenAI API key.'}
            {providerType === 'openai-compatible' && 'Enter the base URL for your OpenAI-compatible server.'}
            {providerType === 'litellm' && 'Enter your API key and optional base URL.'}
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {showBaseUrl && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                Base URL {baseUrlRequired && <span className="text-destructive">*</span>}
              </span>
              <Input
                value={baseUrl}
                onChange={handleBaseUrlChange}
                placeholder={baseUrlPlaceholder}
                autoFocus={providerType === 'openai-compatible'}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              API Key {apiKeyRequired && <span className="text-destructive">*</span>}
            </span>
            <Input
              type="password"
              value={apiKey}
              onChange={handleApiKeyChange}
              placeholder={apiKeyPlaceholder}
              autoFocus={!showBaseUrl}
            />
          </div>
        </div>

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="default" size="sm" onClick={onNext} disabled={!canContinue}>
            Continue
          </Button>
        </div>
      </div>
    );
  }
);
OnboardingCredentialsStep.displayName = 'OnboardingCredentialsStep';
