import { getActiveProduct } from '@/lib/product';

/** Pinned product version — single source of truth is the bundled `ProductDefinition`. */
export const OMNI_CODE_VERSION = getActiveProduct().pinnedVersion;

export type VersionCheckResult = {
  isOutdated: boolean;
  installedVersion: string;
  expectedVersion: string;
};

export const checkOmniVersion = (installedVersion: string): VersionCheckResult => {
  return {
    isOutdated: installedVersion !== OMNI_CODE_VERSION,
    installedVersion,
    expectedVersion: OMNI_CODE_VERSION,
  };
};
