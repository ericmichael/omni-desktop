import { atom } from 'nanostores';

import type { PluginKind } from '@/renderer/features/Plugins/plugin-cards';
import { persistedStoreApi } from '@/renderer/services/store';

/**
 * One-shot deep link into the Plugins tab with a kind filter pre-selected.
 * PluginsView stays mounted for the app's lifetime (lazy-mount-never-unmount
 * layout), so it watches this atom and clears it on consume — same pattern
 * as Settings' `$settingsInitialTab`.
 */
export const $pluginsInitialFilter = atom<PluginKind | 'all' | null>(null);

/** Navigate to the Plugins tab, optionally filtered to one kind. */
export const openPlugins = (filter: PluginKind | 'all' = 'all') => {
  $pluginsInitialFilter.set(filter);
  void persistedStoreApi.setKey('layoutMode', 'plugins');
};
