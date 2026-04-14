import { makeStyles, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { Caption1, Card, ProgressBar, Subtitle1 } from '@/renderer/ds';
import { OnboardingCliStep } from '@/renderer/features/Onboarding/OnboardingCliStep';
import { OnboardingCredentialsStep } from '@/renderer/features/Onboarding/OnboardingCredentialsStep';
import { OnboardingModelStep } from '@/renderer/features/Onboarding/OnboardingModelStep';
import { OnboardingProviderTypeStep } from '@/renderer/features/Onboarding/OnboardingProviderTypeStep';
import { OnboardingValidationStep } from '@/renderer/features/Onboarding/OnboardingValidationStep';
import { configApi } from '@/renderer/services/config';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ModelsConfig, ProviderEntry } from '@/shared/types';

type Step = 'provider' | 'credentials' | 'model' | 'validate' | 'cli';

const FULL_STEP_ORDER: Step[] = ['provider', 'credentials', 'model', 'validate', 'cli'];
const SHORT_STEP_ORDER: Step[] = ['cli'];

const hasProviders = (config: ModelsConfig | null): boolean => {
  if (!config || config.version !== 3) {
return false;
}
  return Object.keys(config.providers).length > 0;
};

const DEFAULT_PROVIDER_NAMES: Record<string, string> = {
  openai: 'openai',
  'openai-compatible': 'local',
  litellm: 'litellm',
  azure: 'azure',
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  card: {
    width: '100%',
    maxWidth: '480px',
    padding: '32px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
});

export const OnboardingWizard = memo(() => {
  const styles = useStyles();
  const [step, setStep] = useState<Step | null>(null);
  const [modelsExist, setModelsExist] = useState(false);
  const [providerType, setProviderType] = useState<ProviderEntry['type'] | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    const check = async () => {
      const configDir = await configApi.getOmniConfigDir();
      const existing = (await configApi.readJsonFile(`${configDir}/models.json`)) as ModelsConfig | null;
      const exists = hasProviders(existing);
      setModelsExist(exists);
      setStep(exists ? 'cli' : 'provider');
    };
    check();
  }, []);

  const stepOrder = modelsExist ? SHORT_STEP_ORDER : FULL_STEP_ORDER;
  const stepIndex = step ? stepOrder.indexOf(step) : 0;

  const goToStep = useCallback((target: Step) => setStep(target), []);

  const handleProviderNext = useCallback(() => goToStep('credentials'), [goToStep]);
  const handleCredentialsNext = useCallback(() => goToStep('model'), [goToStep]);
  const handleCredentialsBack = useCallback(() => goToStep('provider'), [goToStep]);
  const handleModelBack = useCallback(() => goToStep('credentials'), [goToStep]);

  const handleModelNext = useCallback(async () => {
    if (!providerType || !modelId.trim()) {
return;
}

    const providerName = DEFAULT_PROVIDER_NAMES[providerType] ?? 'openai';
    const modelKey = modelId.split('/').pop() || modelId;
    const label = displayName.trim() || modelKey;

    const configDir = await configApi.getOmniConfigDir();
    const existing = (await configApi.readJsonFile(`${configDir}/models.json`)) as ModelsConfig | null;

    const config: ModelsConfig =
      existing?.version === 3 ? existing : { version: 3, default: null, voice_default: null, providers: {} };

    const provider: ProviderEntry = config.providers[providerName] ?? { type: providerType, models: {} };
    provider.type = providerType;
    if (apiKey.trim()) {
provider.api_key = apiKey.trim();
}
    if (baseUrl.trim()) {
provider.base_url = baseUrl.trim();
}

    provider.models[modelKey] = {
      model: modelId.trim(),
      label,
      max_input_tokens: 272000,
      max_output_tokens: 128000,
      model_settings: { store: false, extra_body: { include: ['reasoning.encrypted_content'] } },
    };

    config.providers[providerName] = provider;
    if (!config.default) {
config.default = `${providerName}/${modelKey}`;
}

    await configApi.writeJsonFile(`${configDir}/models.json`, config);
    goToStep('validate');
  }, [providerType, modelId, displayName, apiKey, baseUrl, goToStep]);

  const handleValidateBack = useCallback(() => goToStep('model'), [goToStep]);
  const handleValidateNext = useCallback(() => goToStep('cli'), [goToStep]);
  const handleCliBack = useCallback(() => goToStep('validate'), [goToStep]);

  const handleFinish = useCallback(async () => {
    await persistedStoreApi.setKey('onboardingComplete', true);
  }, []);

  if (!step) {
return null;
}

  return (
    <div className={styles.root}>
      <Card className={styles.card}>
        <div className={styles.header}>
          <Subtitle1>{modelsExist ? 'Welcome back' : 'Welcome to Omni'}</Subtitle1>
          <Caption1>
            {modelsExist
              ? 'Your model configuration is already set up. Just a couple more things.'
              : "Let's set up your first model provider to get started."}
          </Caption1>
        </div>

        {stepOrder.length > 1 && (
          <ProgressBar value={(stepIndex + 1) / stepOrder.length} thickness="large" />
        )}

        {step === 'provider' && (
          <OnboardingProviderTypeStep selected={providerType} onSelect={setProviderType} onNext={handleProviderNext} />
        )}
        {step === 'credentials' && providerType && (
          <OnboardingCredentialsStep
            providerType={providerType}
            apiKey={apiKey}
            baseUrl={baseUrl}
            onChangeApiKey={setApiKey}
            onChangeBaseUrl={setBaseUrl}
            onNext={handleCredentialsNext}
            onBack={handleCredentialsBack}
          />
        )}
        {step === 'model' && providerType && (
          <OnboardingModelStep
            providerType={providerType}
            modelId={modelId}
            displayName={displayName}
            onChangeModelId={setModelId}
            onChangeDisplayName={setDisplayName}
            onNext={handleModelNext}
            onBack={handleModelBack}
          />
        )}
        {step === 'validate' && (
          <OnboardingValidationStep onBack={handleValidateBack} onFinish={handleValidateNext} />
        )}
        {step === 'cli' && (
          <OnboardingCliStep onBack={modelsExist ? undefined : handleCliBack} onFinish={handleFinish} />
        )}
      </Card>
    </div>
  );
});
OnboardingWizard.displayName = 'OnboardingWizard';
