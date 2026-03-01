import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { Sidebar } from '@/renderer/app/Sidebar';
import { Chat } from '@/renderer/features/Chat/Chat';
import { Code } from '@/renderer/features/Code/Code';
import { Fleet } from '@/renderer/features/Fleet/Fleet';
import { Omni } from '@/renderer/features/Omni/Omni';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { persistedStoreApi } from '@/renderer/services/store';

export const MainContent = memo(() => {
  const store = useStore(persistedStoreApi.$atom);

  if (!store.onboardingComplete) {
    return <OnboardingWizard />;
  }

  return (
    <div className="flex w-full h-full">
      <Sidebar />
      <div className="flex-1 min-w-0 min-h-0">
        {store.layoutMode === 'chat' ? (
          <Chat />
        ) : store.layoutMode === 'fleet' ? (
          <Fleet />
        ) : store.layoutMode === 'code' ? (
          <Code />
        ) : (
          <Omni />
        )}
      </div>
    </div>
  );
});
MainContent.displayName = 'MainContent';
