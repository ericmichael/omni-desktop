import { marimoManifest } from '@/main/extensions/marimo';
import type { ExtensionManifest } from '@/main/extensions/types';

/**
 * Built-in extension registry. Add new manifests here. Eventually this can
 * grow into a discovery layer that loads user-installed manifests from
 * `~/.omni/extensions/`, but the contract stays the same.
 */
export const BUILTIN_EXTENSIONS: ExtensionManifest[] = [marimoManifest];

export const getManifest = (id: string): ExtensionManifest | null =>
  BUILTIN_EXTENSIONS.find((m) => m.id === id) ?? null;
