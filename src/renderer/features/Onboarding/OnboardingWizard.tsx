import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useState } from 'react';

import { Heading } from '@/renderer/ds';
import { OnboardingCredentialsStep } from '@/renderer/features/Onboarding/OnboardingCredentialsStep';
import { OnboardingModelStep } from '@/renderer/features/Onboarding/OnboardingModelStep';
import { OnboardingProviderTypeStep } from '@/renderer/features/Onboarding/OnboardingProviderTypeStep';
import { OnboardingValidationStep } from '@/renderer/features/Onboarding/OnboardingValidationStep';
import { configApi } from '@/renderer/services/config';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ModelsConfig, ProviderEntry } from '@/shared/types';

type Step = 'provider' | 'credentials' | 'model' | 'validate';

const STEP_ORDER: Step[] = ['provider', 'credentials', 'model', 'validate'];

const stepVariants = {
  enter: { opacity: 0, x: 40 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -40 },
};

const DEFAULT_PROVIDER_NAMES: Record<string, string> = {
  openai: 'openai',
  'openai-compatible': 'local',
  litellm: 'litellm',
  azure: 'azure',
};

export const OnboardingWizard = memo(() => {
  const [step, setStep] = useState<Step>('provider');
  const [providerType, setProviderType] = useState<ProviderEntry['type'] | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');

  const stepIndex = STEP_ORDER.indexOf(step);

  const goToStep = useCallback((target: Step) => {
    setStep(target);
  }, []);

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

    const provider: ProviderEntry = config.providers[providerName] ?? {
      type: providerType,
      models: {},
    };

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
    };

    config.providers[providerName] = provider;

    // Set as default if no default exists
    if (!config.default) {
      config.default = `${providerName}/${modelKey}`;
    }

    await configApi.writeJsonFile(`${configDir}/models.json`, config);

    goToStep('validate');
  }, [providerType, modelId, displayName, apiKey, baseUrl, goToStep]);

  const handleValidateBack = useCallback(() => goToStep('model'), [goToStep]);

  const handleFinish = useCallback(async () => {
    await persistedStoreApi.setKey('onboardingComplete', true);
  }, []);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-xl border border-surface-border/50 bg-surface-raised/80 p-8 shadow-xl backdrop-blur-sm">
        <div className="flex flex-col gap-1">
          <Heading as="h1" size="lg">
            Welcome to Omni
          </Heading>
          <p className="text-sm text-fg-muted">Let&apos;s set up your first model provider to get started.</p>
        </div>

        {/* Step indicators */}
        <div className="flex gap-1.5">
          {STEP_ORDER.map((s, i) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= stepIndex ? 'bg-accent-500' : 'bg-surface-border/50'
              }`}
            />
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2 }}
          >
            {step === 'provider' && (
              <OnboardingProviderTypeStep
                selected={providerType}
                onSelect={setProviderType}
                onNext={handleProviderNext}
              />
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
            {step === 'validate' && <OnboardingValidationStep onBack={handleValidateBack} onFinish={handleFinish} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
});
OnboardingWizard.displayName = 'OnboardingWizard';
