import { makeStyles, tokens } from '@fluentui/react-components';
import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';

import { Body1Strong, Button, Caption1, Input } from '@/renderer/ds';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '24px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  fields: { display: 'flex', flexDirection: 'column', gap: '16px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  required: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: 'flex', justifyContent: 'space-between' },
});

export const OnboardingCredentialsStep = memo(
  ({ providerType, apiKey, baseUrl, onChangeApiKey, onChangeBaseUrl, onNext, onBack }: Props) => {
    const styles = useStyles();
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
      <div className={styles.root}>
        <div className={styles.header}>
          <Body1Strong>Enter credentials</Body1Strong>
          <Caption1>
            {providerType === 'openai' && 'Enter your OpenAI API key.'}
            {providerType === 'openai-compatible' && 'Enter the base URL for your OpenAI-compatible server.'}
            {providerType === 'litellm' && 'Enter your API key and optional base URL.'}
          </Caption1>
        </div>

        <div className={styles.fields}>
          {showBaseUrl && (
            <div className={styles.field}>
              <Caption1>
                Base URL {baseUrlRequired && <span className={styles.required}>*</span>}
              </Caption1>
              <Input
                value={baseUrl}
                onChange={handleBaseUrlChange}
                placeholder={baseUrlPlaceholder}
                autoFocus={providerType === 'openai-compatible'}
                size="sm"
              />
            </div>
          )}

          <div className={styles.field}>
            <Caption1>
              API Key {apiKeyRequired && <span className={styles.required}>*</span>}
            </Caption1>
            <Input
              type="password"
              value={apiKey}
              onChange={handleApiKeyChange}
              placeholder={apiKeyPlaceholder}
              autoFocus={!showBaseUrl}
              size="sm"
            />
          </div>
        </div>

        <div className={styles.actions}>
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
