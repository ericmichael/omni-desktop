export const OMNI_CODE_VERSION = '0.4.51';

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
