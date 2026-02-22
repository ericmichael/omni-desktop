import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds';
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

const INPUT_CLASS =
  'h-9 w-full px-3 text-sm rounded-md bg-transparent border border-surface-border/50 text-fg font-mono outline-none focus:border-accent-500/50 placeholder:text-fg-muted/50';

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
          <h3 className="text-lg font-semibold text-fg">Enter credentials</h3>
          <p className="text-sm text-fg-muted">
            {providerType === 'openai' && 'Enter your OpenAI API key.'}
            {providerType === 'openai-compatible' && 'Enter the base URL for your OpenAI-compatible server.'}
            {providerType === 'litellm' && 'Enter your API key and optional base URL.'}
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {showBaseUrl && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-fg" htmlFor="onboarding-base-url">
                Base URL {baseUrlRequired && <span className="text-red-400">*</span>}
              </label>
              <input
                id="onboarding-base-url"
                type="text"
                value={baseUrl}
                onChange={handleBaseUrlChange}
                placeholder={baseUrlPlaceholder}
                className={INPUT_CLASS}
                autoFocus={providerType === 'openai-compatible'}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-fg" htmlFor="onboarding-api-key">
              API Key {apiKeyRequired && <span className="text-red-400">*</span>}
            </label>
            <input
              id="onboarding-api-key"
              type="password"
              value={apiKey}
              onChange={handleApiKeyChange}
              placeholder={apiKeyPlaceholder}
              className={INPUT_CLASS}
              autoFocus={!showBaseUrl}
            />
          </div>
        </div>

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="primary" size="sm" onClick={onNext} isDisabled={!canContinue}>
            Continue
          </Button>
        </div>
      </div>
    );
  }
);
OnboardingCredentialsStep.displayName = 'OnboardingCredentialsStep';
