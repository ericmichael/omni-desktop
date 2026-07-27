import { codeApi } from '@/renderer/features/Code/state';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

/**
 * Boot landing: every app launch opens in a fresh chat (the ChatGPT model) —
 * history and every other surface are one sidebar click away, from the
 * persistent column on desktop or the nav drawer on mobile. `openFreshChat`
 * reuses a pristine column, so this never accumulates empties.
 */
let started = false;

export const initBootLanding = (): void => {
  if (started) {
    return;
  }
  started = true;

  const land = (): void => {
    if (!persistedStoreApi.get().onboardingComplete) {
      return; // onboarding owns the first run
    }
    if (persistedStoreApi.get().layoutMode !== 'chat') {
      void persistedStoreApi.setKey('layoutMode', 'chat');
    }
    void codeApi.openFreshChat();
  };

  if ($initialized.get()) {
    land();
  } else {
    const unsubscribe = $initialized.listen((ready) => {
      if (ready) {
        unsubscribe();
        land();
      }
    });
  }
};
