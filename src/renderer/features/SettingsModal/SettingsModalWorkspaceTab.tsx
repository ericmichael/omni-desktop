import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Card, FormField, MessageBar, MessageBarBody, SectionLabel, Select } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { $omniInstallProcessStatus, $omniRuntimeInfo, omniInstallApi } from '@/renderer/features/Omni/state';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter, isElectron } from '@/renderer/services/ipc';
import { persistedStoreApi, selectWorkspaceDir } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  sectionLabelSpaced: { marginTop: tokens.spacingVerticalS },
  text: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '200px',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  textSimple: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

/**
 * Developer band: where sessions run and what runs them — workspace
 * directory, sandbox profile, the omni runtime, and the CLI symlink.
 */
export const SettingsModalWorkspaceTab = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);
  const installStatus = useStore($omniInstallProcessStatus);
  const launcherVersion = useStore($launcherVersion);
  const [isEnterprise, setIsEnterprise] = useState(false);

  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  const isInstalling = installStatus.type === 'starting' || installStatus.type === 'installing';

  const [cliInPath, setCliInPath] = useState<{ installed: boolean; symlinkPath: string } | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);

  const checkCliStatus = useCallback(async () => {
    const status = await emitter.invoke('util:get-cli-in-path-status');
    setCliInPath(status);
  }, []);

  useEffect(() => {
    checkCliStatus();
  }, [checkCliStatus, runtimeInfo]);

  const installCliToPath = useCallback(async () => {
    setCliInstalling(true);
    setCliError(null);
    try {
      const result = await emitter.invoke('util:install-cli-to-path');
      if (!result.success) {
        setCliError(result.error);
      }
      await checkCliStatus();
    } finally {
      setCliInstalling(false);
    }
  }, [checkCliStatus]);

  const availableProfiles = useMemo<string[]>(
    () => getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles }),
    [isEnterprise, store.availableSandboxProfiles]
  );

  const onChangeProfile = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('defaultProfileName', e.target.value);
  }, []);

  const reinstallRuntime = useCallback(() => {
    omniInstallApi.startInstall(true);
  }, []);

  const currentProfile = store.defaultProfileName ?? 'host';
  const showSandboxSection = isEnterprise || store.previewFeatures || import.meta.env.MODE === 'development';

  return (
    <div className={styles.root}>
      {/* Host-filesystem concept; hosted mode mounts a workspace via Azure Files. */}
      {isElectron && (
        <>
          <SectionLabel>Workspace</SectionLabel>
          <Card>
            <FormField label="Workspace directory">
              <span className={styles.text}>{store.workspaceDir ?? 'Default'}</span>
              <Button size="sm" variant="ghost" onClick={selectWorkspaceDir}>
                Change
              </Button>
            </FormField>
          </Card>
        </>
      )}

      {showSandboxSection && (
        <>
          <SectionLabel className={styles.sectionLabelSpaced}>Sandbox</SectionLabel>
          <Card>
            <FormField label="Default sandbox profile">
              <Select value={currentProfile} onChange={onChangeProfile}>
                {availableProfiles.map((name) => (
                  <option key={name} value={name}>
                    {getProfileMenuLabel(name)}
                  </option>
                ))}
              </Select>
            </FormField>
          </Card>
        </>
      )}

      {/* Runtime install + CLI-in-PATH are host operations; in cloud the runtime is image-baked. */}
      {!isEnterprise && isElectron && (
        <>
          <SectionLabel className={styles.sectionLabelSpaced}>Runtime</SectionLabel>
          <Card>
            <FormField label={`Runtime${runtimeInfo.isInstalled ? ` (v${runtimeInfo.version})` : ''}`}>
              <Button size="sm" variant="ghost" onClick={reinstallRuntime} isDisabled={isInstalling}>
                {isInstalling
                  ? runtimeInfo.isInstalled
                    ? 'Reinstalling…'
                    : 'Installing…'
                  : runtimeInfo.isInstalled
                    ? 'Reinstall'
                    : 'Install'}
              </Button>
            </FormField>
            <FormField label="'omni' command in PATH">
              {cliInPath?.installed ? (
                <span className={styles.textSimple}>Installed</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={installCliToPath}
                  isDisabled={!runtimeInfo.isInstalled || cliInstalling}
                >
                  {cliInstalling ? 'Installing…' : 'Install'}
                </Button>
              )}
            </FormField>
            {cliError && (
              <MessageBar intent="error">
                <MessageBarBody>{cliError}</MessageBarBody>
              </MessageBar>
            )}
          </Card>
        </>
      )}

      <SectionLabel className={styles.sectionLabelSpaced}>About</SectionLabel>
      <Card>
        <FormField label="Launcher version">
          <span className={styles.textSimple}>{launcherVersion ?? '—'}</span>
        </FormField>
        <FormField label="Compute">
          <span className={styles.textSimple}>
            {currentProfile === 'platform' ? 'Managed' : currentProfile === 'host' ? 'None' : 'Local'}
          </span>
        </FormField>
      </Card>
    </div>
  );
});
SettingsModalWorkspaceTab.displayName = 'SettingsModalWorkspaceTab';
