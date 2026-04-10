import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';

import { makeStyles, tokens } from '@fluentui/react-components';
import { Button, Card, FormField, MessageBar, MessageBarBody, SectionLabel, Select, Switch } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import {
  $omniInstallProcessStatus,
  $omniRuntimeInfo,
  omniInstallApi,
} from '@/renderer/features/Omni/state';
import { $chatProcessStatus } from '@/renderer/features/Chat/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi, selectWorkspaceDir } from '@/renderer/services/store';
import type { OmniTheme, SandboxBackend, SandboxVariant } from '@/shared/types';

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

export const SettingsModalOmniSandboxOptions = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);
  const installStatus = useStore($omniInstallProcessStatus);
  const sandboxStatus = useStore($chatProcessStatus);
  const launcherVersion = useStore($launcherVersion);
  const [isEnterprise, setIsEnterprise] = useState(false);

  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  const isInstalling = installStatus.type === 'starting' || installStatus.type === 'installing';
  const [imageRebuilding, setIsRebuilding] = useState(false);
  const isRebuilding = imageRebuilding || sandboxStatus.type === 'starting' || sandboxStatus.type === 'stopping';

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

  const onToggleSandboxEnabled = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('sandboxEnabled', checked);
  }, []);

  const onChangeSandboxVariant = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('sandboxVariant', e.target.value as SandboxVariant);
  }, []);

  const onChangeSandboxBackend = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('sandboxBackend', e.target.value as SandboxBackend);
  }, []);

  const rebuildDockerImage = useCallback(async () => {
    setIsRebuilding(true);
    try {
      const result = await emitter.invoke('util:rebuild-sandbox-image');
      if (result && !result.success) {
        console.error('Sandbox image rebuild failed:', result.error);
      }
    } finally {
      setIsRebuilding(false);
    }
  }, []);

  const reinstallRuntime = useCallback(() => {
    omniInstallApi.startInstall(true);
  }, []);

  const onChangeTheme = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('theme', e.target.value as OmniTheme);
  }, []);

  return (
    <div className={styles.root}>
      <SectionLabel>Workspace</SectionLabel>
      <Card>
        <FormField label="Workspace directory">
          <span className={styles.text}>{store.workspaceDir ?? 'Default'}</span>
          <Button size="sm" variant="ghost" onClick={selectWorkspaceDir}>
            Change
          </Button>
        </FormField>
      </Card>

      <SectionLabel className={styles.sectionLabelSpaced}>Sandbox</SectionLabel>
      <Card>
        <FormField label={isEnterprise ? 'Use local sandbox' : 'Enable sandbox (Docker)'}>
          <Switch
            checked={isEnterprise ? !(store.sandboxEnabled ?? true) : (store.sandboxEnabled ?? false)}
            onCheckedChange={isEnterprise ? (checked) => onToggleSandboxEnabled(!checked) : onToggleSandboxEnabled}
          />
        </FormField>
        {!isEnterprise && (
          <>
            <FormField label="Sandbox backend">
              <Select value={store.sandboxBackend ?? 'docker'} onChange={onChangeSandboxBackend} disabled={!store.sandboxEnabled}>
                <option value="local">Local (bwrap)</option>
                <option value="docker">Docker</option>
                <option value="podman">Podman</option>
                <option value="vm">VM (QEMU)</option>
              </Select>
            </FormField>
            <FormField label="Sandbox variant">
              <Select value={store.sandboxVariant ?? 'work'} onChange={onChangeSandboxVariant} disabled={!store.sandboxEnabled}>
                <option value="work">Work</option>
                <option value="standard">Standard</option>
              </Select>
            </FormField>
            {(import.meta.env.MODE === 'development' || store.previewFeatures) && ((store.sandboxBackend ?? 'docker') === 'docker' || store.sandboxBackend === 'podman') && (
              <FormField label={`Rebuild ${store.sandboxBackend === 'podman' ? 'Podman' : 'Docker'} image`}>
                <Button size="sm" variant="ghost" onClick={rebuildDockerImage} isDisabled={isRebuilding}>
                  {isRebuilding ? 'Rebuilding\u2026' : 'Rebuild'}
                </Button>
              </FormField>
            )}
          </>
        )}
      </Card>

      <SectionLabel className={styles.sectionLabelSpaced}>Display</SectionLabel>
      <Card>
        <FormField label="Theme">
          <Select value={store.theme ?? 'teams-light'} onChange={onChangeTheme}>
            <option value="teams-light">Teams Light</option>
            <option value="teams-dark">Teams Dark</option>
            <option value="default">Indigo Dark</option>
            <option value="tokyo-night">Tokyo Night</option>
            <option value="vscode-dark">VS Code Dark</option>
            <option value="vscode-light">VS Code Light</option>
            <option value="utrgv">UTRGV</option>
          </Select>
        </FormField>
      </Card>

      {!isEnterprise && (
        <>
          <SectionLabel className={styles.sectionLabelSpaced}>Runtime</SectionLabel>
          <Card>
            <FormField label={`Runtime${runtimeInfo.isInstalled ? ` (v${runtimeInfo.version})` : ''}`}>
              <Button size="sm" variant="ghost" onClick={reinstallRuntime} isDisabled={isInstalling}>
                {isInstalling
                  ? runtimeInfo.isInstalled
                    ? 'Reinstalling\u2026'
                    : 'Installing\u2026'
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
                  {cliInstalling ? 'Installing\u2026' : 'Install'}
                </Button>
              )}
            </FormField>
            {cliError && (
              <MessageBar intent="error"><MessageBarBody>{cliError}</MessageBarBody></MessageBar>
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
            {isEnterprise && store.sandboxEnabled !== false ? 'Managed' : 'Local'}
          </span>
        </FormField>
      </Card>
    </div>
  );
});

SettingsModalOmniSandboxOptions.displayName = 'SettingsModalOmniSandboxOptions';
