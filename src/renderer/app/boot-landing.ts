import { codeApi } from '@/renderer/features/Code/state';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

/**
 * Desktop boot landing: every app launch opens in a fresh chat (the
 * ChatGPT-desktop model) — history and every other surface are one sidebar
 * click away. `openFreshChat` reuses a pristine column, so this never
 * accumulates empties. Mobile is untouched: the Home page is its landing,
 * and forcing a mode change here would dismiss it.
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
    if (!window.matchMedia('(min-width: 640px)').matches) {
      return;
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
