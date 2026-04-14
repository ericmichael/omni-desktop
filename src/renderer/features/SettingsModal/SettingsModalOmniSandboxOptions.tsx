import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Button, Card, FormField, MessageBar, MessageBarBody, SectionLabel, Select } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { $chatProcessStatus } from '@/renderer/features/Chat/state';
import {
  $omniInstallProcessStatus,
  $omniRuntimeInfo,
  omniInstallApi,
} from '@/renderer/features/Omni/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi, selectWorkspaceDir } from '@/renderer/services/store';
import type { OmniTheme, SandboxBackend } from '@/shared/types';

const BACKEND_LABELS: Record<SandboxBackend, string> = {
  platform: 'Cloud (managed)',
  docker: 'Docker',
  podman: 'Podman',
  vm: 'VM (QEMU)',
  local: 'Local (bwrap)',
  none: 'No sandbox',
};

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

/** All backends available in open-source mode (no platform policy). */
const OPEN_SOURCE_BACKENDS: SandboxBackend[] = ['docker', 'podman', 'vm', 'local', 'none'];

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

  // Derive available backends from policy or fall back to open-source defaults
  const profiles = store.sandboxProfiles;
  const availableBackends: SandboxBackend[] = profiles
    ? [...new Set(profiles.map((p) => p.backend)), 'none' as const]
    : OPEN_SOURCE_BACKENDS;

  const onChangeSandboxBackend = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const backend = e.target.value as SandboxBackend;
    persistedStoreApi.setKey('sandboxBackend', backend);

    // Auto-select the first matching machine profile
    if (profiles) {
      const match = profiles.find((p) => p.backend === backend);
      persistedStoreApi.setKey('selectedMachineId', match?.resource_id ?? null);
    }
  }, [profiles]);

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

  const deckBgInputRef = useRef<HTMLInputElement>(null);
  const pickDeckBackground = useCallback(() => {
    deckBgInputRef.current?.click();
  }, []);
  const clearDeckBackground = useCallback(() => {
    persistedStoreApi.setKey('codeDeckBackground', null);
  }, []);
  const onDeckBackgroundFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
return;
}
    if (!file.type.startsWith('image/')) {
      window.alert('Please choose an image file.');
      return;
    }
    const MAX = 3 * 1024 * 1024;
    if (file.size > MAX) {
      window.alert(`Image is too large (max ${Math.round(MAX / 1024 / 1024)}MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        persistedStoreApi.setKey('codeDeckBackground', result);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const currentBackend = store.sandboxBackend ?? 'none';
  const showSandboxSection = isEnterprise || store.previewFeatures || import.meta.env.MODE === 'development';
  const showRebuild = showSandboxSection && (currentBackend === 'docker' || currentBackend === 'podman');

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

      {showSandboxSection && (
        <>
          <SectionLabel className={styles.sectionLabelSpaced}>Sandbox</SectionLabel>
          <Card>
            <FormField label="Sandbox backend">
              <Select value={currentBackend} onChange={onChangeSandboxBackend}>
                {availableBackends.map((b) => (
                  <option key={b} value={b}>{BACKEND_LABELS[b]}</option>
                ))}
              </Select>
            </FormField>
            {showRebuild && (
              <FormField label={`Rebuild ${currentBackend === 'podman' ? 'Podman' : 'Docker'} image`}>
                <Button size="sm" variant="ghost" onClick={rebuildDockerImage} isDisabled={isRebuilding}>
                  {isRebuilding ? 'Rebuilding\u2026' : 'Rebuild'}
                </Button>
              </FormField>
            )}
          </Card>
        </>
      )}

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
        <FormField label="Code Deck background">
          <span className={styles.textSimple}>{store.codeDeckBackground ? 'Custom image' : 'None'}</span>
          <input
            ref={deckBgInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onDeckBackgroundFile}
          />
          <Button size="sm" variant="ghost" onClick={pickDeckBackground}>
            {store.codeDeckBackground ? 'Change' : 'Upload'}
          </Button>
          {store.codeDeckBackground && (
            <Button size="sm" variant="ghost" onClick={clearDeckBackground}>
              Remove
            </Button>
          )}
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
            {currentBackend === 'platform' ? 'Managed' : currentBackend === 'none' ? 'None' : 'Local'}
          </span>
        </FormField>
      </Card>
    </div>
  );
});

SettingsModalOmniSandboxOptions.displayName = 'SettingsModalOmniSandboxOptions';
