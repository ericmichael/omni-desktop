import { makeStyles, tokens } from '@fluentui/react-components';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useState } from 'react';

import { buildProviderConfig, maskApiKey } from '@/lib/provider-config';
import { OmniMark } from '@/renderer/common/OmniMark';
import { Caption1, Card, ProgressBar } from '@/renderer/ds';
import { OnboardingChatGptStep } from '@/renderer/features/Onboarding/OnboardingChatGptStep';
import type { IdentityKind } from '@/renderer/features/Onboarding/OnboardingChooseStep';
import { OnboardingChooseStep } from '@/renderer/features/Onboarding/OnboardingChooseStep';
import { OnboardingConnectedStep } from '@/renderer/features/Onboarding/OnboardingConnectedStep';
import { OnboardingCredentialsStep } from '@/renderer/features/Onboarding/OnboardingCredentialsStep';
import { OnboardingKeyEntryStep } from '@/renderer/features/Onboarding/OnboardingKeyEntryStep';
import { OnboardingLocalStep } from '@/renderer/features/Onboarding/OnboardingLocalStep';
import type { PickedModel } from '@/renderer/features/Onboarding/OnboardingModelPickStep';
import { OnboardingModelPickStep } from '@/renderer/features/Onboarding/OnboardingModelPickStep';
import { OnboardingModelStep } from '@/renderer/features/Onboarding/OnboardingModelStep';
import { OnboardingProviderTypeStep } from '@/renderer/features/Onboarding/OnboardingProviderTypeStep';
import { OnboardingValidationStep } from '@/renderer/features/Onboarding/OnboardingValidationStep';
import { agentConfigApi } from '@/renderer/services/config';
import { isElectron } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { resolveModelChoices } from '@/shared/model-catalog';
import type { ProviderEntry } from '@/shared/types';

type Step =
  | 'choose'
  | 'chatgpt'
  | 'key-entry'
  | 'local'
  | 'model-pick'
  | 'connected'
  | 'adv-provider'
  | 'adv-credentials'
  | 'adv-model'
  | 'adv-validate';

/** Per-branch step order, for the progress bar. */
const BRANCH_STEPS: Record<IdentityKind, Step[]> = {
  chatgpt: ['choose', 'chatgpt', 'connected'],
  openai: ['choose', 'key-entry', 'model-pick', 'connected'],
  anthropic: ['choose', 'key-entry', 'model-pick', 'connected'],
  local: ['choose', 'local', 'model-pick', 'connected'],
  advanced: ['choose', 'adv-provider', 'adv-credentials', 'adv-model', 'adv-validate', 'connected'],
};

/** Advanced flow: stable provider-entry names per runtime type. */
const ADVANCED_PROVIDER_NAMES: Record<string, string> = {
  openai: 'openai',
  'openai-compatible': 'local',
  litellm: 'litellm',
  azure: 'azure',
};

const ADVANCED_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  'openai-compatible': 'your server',
  litellm: 'LiteLLM',
  azure: 'Azure',
};

type ConnectedInfo = { providerLabel: string; modelLabel: string; maskedKey?: string };

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
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
});

const stepVariants = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24 },
};

export const OnboardingWizard = memo(() => {
  const styles = useStyles();
  const [step, setStep] = useState<Step>('choose');
  const [identity, setIdentity] = useState<IdentityKind | null>(null);

  // Identity-flow state
  const [apiKey, setApiKey] = useState('');
  const [localBaseUrl, setLocalBaseUrl] = useState('');
  const [localKind, setLocalKind] = useState<'ollama' | 'openai-compatible'>('ollama');
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [connected, setConnected] = useState<ConnectedInfo | null>(null);

  // Advanced-flow state (the pre-existing three-step setup)
  const [advProviderType, setAdvProviderType] = useState<ProviderEntry['type'] | null>(null);
  const [advApiKey, setAdvApiKey] = useState('');
  const [advBaseUrl, setAdvBaseUrl] = useState('');
  const [advModelId, setAdvModelId] = useState('');
  const [advDisplayName, setAdvDisplayName] = useState('');

  const branch = identity ? BRANCH_STEPS[identity] : null;
  const stepIndex = branch ? branch.indexOf(step) : -1;
  const showProgress = branch !== null && stepIndex > 0 && step !== 'connected';

  const handleChoose = useCallback((kind: IdentityKind) => {
    setIdentity(kind);
    if (kind === 'chatgpt') {
      setStep('chatgpt');
    } else if (kind === 'openai' || kind === 'anthropic') {
      setStep('key-entry');
    } else if (kind === 'local') {
      setStep('local');
    } else {
      setStep('adv-provider');
    }
  }, []);

  const handleBackToChoose = useCallback(() => {
    setIdentity(null);
    setApiKey('');
    setLiveModels([]);
    setStep('choose');
  }, []);

  const handleKeyValidated = useCallback((key: string, models: string[]) => {
    setApiKey(key);
    setLiveModels(models);
    setStep('model-pick');
  }, []);

  const handleLocalDetected = useCallback((kind: 'ollama' | 'openai-compatible', baseUrl: string, models: string[]) => {
    setLocalKind(kind);
    setLocalBaseUrl(baseUrl);
    setLiveModels(models);
    setStep('model-pick');
  }, []);

  const handleEscapeToAdvanced = useCallback(() => {
    setIdentity('advanced');
    setStep('adv-provider');
  }, []);

  const handleModelPickBack = useCallback(() => {
    setStep(identity === 'local' ? 'local' : 'key-entry');
  }, [identity]);

  const handleModelPicked = useCallback(
    async (model: PickedModel) => {
      const kind = identity === 'openai' ? 'openai' : identity === 'anthropic' ? 'anthropic' : localKind;
      const current = await agentConfigApi.getModels();
      const { config } = buildProviderConfig(current, {
        kind,
        ...(apiKey ? { apiKey } : {}),
        ...(localBaseUrl ? { baseUrl: localBaseUrl } : {}),
        model,
        makeDefault: 'always',
      });
      await agentConfigApi.setModels(config);
      const providerLabel =
        identity === 'openai' ? 'OpenAI' : identity === 'anthropic' ? 'Anthropic' : kind === 'ollama' ? 'Ollama' : 'your local server';
      setConnected({
        providerLabel,
        modelLabel: model.label,
        ...(apiKey ? { maskedKey: maskApiKey(apiKey) } : {}),
      });
      setStep('connected');
    },
    [identity, localKind, apiKey, localBaseUrl]
  );

  const handleChatGptConnected = useCallback((defaultModel: string | undefined) => {
    setConnected({
      providerLabel: 'ChatGPT',
      modelLabel: defaultModel ?? 'ChatGPT models — switch with /model in chat',
    });
    setStep('connected');
  }, []);

  // ── Advanced branch (pre-existing flow, unchanged behavior) ──
  const handleAdvProviderNext = useCallback(() => setStep('adv-credentials'), []);
  const handleAdvCredentialsBack = useCallback(() => setStep('adv-provider'), []);
  const handleAdvCredentialsNext = useCallback(() => setStep('adv-model'), []);
  const handleAdvModelBack = useCallback(() => setStep('adv-credentials'), []);
  const handleAdvValidateBack = useCallback(() => setStep('adv-model'), []);

  const handleAdvModelNext = useCallback(async () => {
    if (!advProviderType || !advModelId.trim()) {
      return;
    }
    const providerName = ADVANCED_PROVIDER_NAMES[advProviderType] ?? 'openai';
    const modelKey = advModelId.split('/').pop() || advModelId;
    const label = advDisplayName.trim() || modelKey;

    const config = await agentConfigApi.getModels();
    const provider: ProviderEntry = config.providers[providerName] ?? { type: advProviderType, models: {} };
    provider.type = advProviderType;
    if (advApiKey.trim()) {
      provider.api_key = advApiKey.trim();
    }
    if (advBaseUrl.trim()) {
      provider.base_url = advBaseUrl.trim();
    }
    provider.models[modelKey] = {
      model: advModelId.trim(),
      label,
      max_input_tokens: 272000,
      max_output_tokens: 128000,
      ...(advProviderType === 'openai'
        ? { model_settings: { store: false, extra_body: { include: ['reasoning.encrypted_content'] } } }
        : {}),
    };
    config.providers[providerName] = provider;
    if (!config.default) {
      config.default = `${providerName}/${modelKey}`;
    }
    await agentConfigApi.setModels(config);
    setStep('adv-validate');
  }, [advProviderType, advModelId, advDisplayName, advApiKey, advBaseUrl]);

  const handleAdvValidateNext = useCallback(() => {
    setConnected({
      providerLabel: ADVANCED_PROVIDER_LABELS[advProviderType ?? 'openai'] ?? 'your provider',
      modelLabel: advDisplayName.trim() || advModelId,
      ...(advApiKey.trim() ? { maskedKey: maskApiKey(advApiKey) } : {}),
    });
    setStep('connected');
  }, [advProviderType, advDisplayName, advModelId, advApiKey]);

  const handleFinish = useCallback(async () => {
    await persistedStoreApi.setKey('layoutMode', 'chat');
    await persistedStoreApi.setKey('onboardingComplete', true);
  }, []);

  const modelChoices =
    identity === 'openai' || identity === 'anthropic'
      ? resolveModelChoices(identity, liveModels)
      : resolveModelChoices(localKind, liveModels);

  return (
    <div className={styles.root}>
      <Card className={styles.card}>
        <div className={styles.header}>
          <div className={styles.brandRow}>
            <OmniMark size={28} />
            <span className={styles.title}>Welcome to Omni</span>
          </div>
          {step === 'choose' && (
            <Caption1>
              Omni runs AI agents securely on your computer — they chat, write code, browse, and get real work done.
              Connect the AI you already use to power them.
            </Caption1>
          )}
        </div>

        {showProgress && branch && <ProgressBar value={(stepIndex + 1) / branch.length} thickness="large" />}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            variants={stepVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            {step === 'choose' && <OnboardingChooseStep showLocal={isElectron} onSelect={handleChoose} />}

            {step === 'chatgpt' && (
              <OnboardingChatGptStep onConnected={handleChatGptConnected} onBack={handleBackToChoose} />
            )}

            {step === 'key-entry' && (identity === 'openai' || identity === 'anthropic') && (
              <OnboardingKeyEntryStep
                kind={identity}
                onValidated={handleKeyValidated}
                onBack={handleBackToChoose}
                onAdvanced={handleEscapeToAdvanced}
              />
            )}

            {step === 'local' && <OnboardingLocalStep onDetected={handleLocalDetected} onBack={handleBackToChoose} />}

            {step === 'model-pick' && (
              <OnboardingModelPickStep
                choices={modelChoices}
                liveModels={liveModels}
                onContinue={handleModelPicked}
                onBack={handleModelPickBack}
              />
            )}

            {step === 'connected' && connected && (
              <OnboardingConnectedStep
                providerLabel={connected.providerLabel}
                modelLabel={connected.modelLabel}
                maskedKey={connected.maskedKey}
                onFinish={handleFinish}
              />
            )}

            {step === 'adv-provider' && (
              <OnboardingProviderTypeStep
                selected={advProviderType}
                onSelect={setAdvProviderType}
                onNext={handleAdvProviderNext}
                onBack={handleBackToChoose}
              />
            )}
            {step === 'adv-credentials' && advProviderType && (
              <OnboardingCredentialsStep
                providerType={advProviderType}
                apiKey={advApiKey}
                baseUrl={advBaseUrl}
                onChangeApiKey={setAdvApiKey}
                onChangeBaseUrl={setAdvBaseUrl}
                onNext={handleAdvCredentialsNext}
                onBack={handleAdvCredentialsBack}
              />
            )}
            {step === 'adv-model' && advProviderType && (
              <OnboardingModelStep
                providerType={advProviderType}
                modelId={advModelId}
                displayName={advDisplayName}
                onChangeModelId={setAdvModelId}
                onChangeDisplayName={setAdvDisplayName}
                onNext={handleAdvModelNext}
                onBack={handleAdvModelBack}
              />
            )}
            {step === 'adv-validate' && (
              <OnboardingValidationStep onBack={handleAdvValidateBack} onFinish={handleAdvValidateNext} />
            )}
          </motion.div>
        </AnimatePresence>
      </Card>
    </div>
  );
});
OnboardingWizard.displayName = 'OnboardingWizard';
