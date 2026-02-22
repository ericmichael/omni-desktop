import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { Omni } from '@/renderer/features/Omni/Omni';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { persistedStoreApi } from '@/renderer/services/store';

export const MainContent = memo(() => {
  const store = useStore(persistedStoreApi.$atom);

  if (!store.onboardingComplete) {
    return <OnboardingWizard />;
  }

  return <Omni />;
});
MainContent.displayName = 'MainContent';
