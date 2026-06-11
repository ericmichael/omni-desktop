import { atom } from 'nanostores';

import { persistedStoreApi } from '@/renderer/services/store';

/**
 * One-shot deep link into a settings tab. SettingsPage stays mounted for the
 * app's lifetime (lazy-mount-never-unmount layout), so a plain initial prop
 * can't retarget it — it watches this atom instead and clears it on consume.
 */
export const $settingsInitialTab = atom<string | null>(null);

/** Navigate to Settings with a specific tab selected (e.g. the AI fix-it path). */
export const openSettingsTab = (tab: string) => {
  $settingsInitialTab.set(tab);
  void persistedStoreApi.setKey('layoutMode', 'settings');
};
