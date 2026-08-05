import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { $omniInstallProcessStatus, $omniRuntimeInfo, omniInstallApi } from '@/renderer/features/Omni/state';
import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { RemoteBackendCard } from '@/renderer/features/SettingsModal/RemoteBackendCard';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { emitter, isElectron } from '@/renderer/services/ipc';
import { persistedStoreApi, selectWorkspaceDir } from '@/renderer/services/store';

/**
 * Developer band: where sessions run and what runs them — workspace
 * directory, sandbox profile, the omni runtime, and the CLI symlink.
 */
export const SettingsModalWorkspaceTab = memo(() => {
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

  // Subscribing keeps the options current as discovery lands (and triggers
  // the atom's fetch-on-first-subscribe).
  const discovered = useStore($sandboxProfiles);
  const availableProfiles = useMemo<string[]>(
    () => getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles, discovered }),
    [isEnterprise, store.availableSandboxProfiles, discovered]
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
    <SettingsPane>
      {isElectron && (
        <SettingsSection title="Backend">
          <RemoteBackendCard />
        </SettingsSection>
      )}

      {/* Host-filesystem concept; hosted mode mounts a workspace via Azure Files. */}
      {isElectron && (
        <SettingsSection title="Workspace">
          <Card>
            <CardContent>
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>Workspace directory</FieldLabel>
                </div>
                <span className="text-sm text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap max-w-50 sm:text-xs">
                  {store.workspaceDir ?? 'Default'}
                </span>
                <Button size="sm" variant="ghost" onClick={selectWorkspaceDir}>
                  Change
                </Button>
              </Field>
            </CardContent>
          </Card>
        </SettingsSection>
      )}

      {showSandboxSection && (
        <SettingsSection title="Sandbox">
          <Card>
            <CardContent>
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>Default sandbox profile</FieldLabel>
                </div>
                <Select value={currentProfile} onChange={onChangeProfile}>
                  {availableProfiles.map((name) => (
                    <option key={name} value={name}>
                      {getProfileMenuLabel(name)}
                    </option>
                  ))}
                </Select>
              </Field>
            </CardContent>
          </Card>
        </SettingsSection>
      )}

      {/* Runtime install + CLI-in-PATH are host operations; in cloud the runtime is image-baked. */}
      {!isEnterprise && isElectron && (
        <SettingsSection title="Runtime">
          <Card>
            <CardContent className={settingsCardContentClassName}>
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>{`Runtime${runtimeInfo.isInstalled ? ` (v${runtimeInfo.version})` : ''}`}</FieldLabel>
                </div>
                <Button size="sm" variant="ghost" onClick={reinstallRuntime} disabled={isInstalling}>
                  {isInstalling
                    ? runtimeInfo.isInstalled
                      ? 'Reinstalling…'
                      : 'Installing…'
                    : runtimeInfo.isInstalled
                      ? 'Reinstall'
                      : 'Install'}
                </Button>
              </Field>
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>&apos;omni&apos; command in PATH</FieldLabel>
                </div>
                {cliInPath?.installed ? (
                  <span className="text-sm text-muted-foreground sm:text-xs">Installed</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={installCliToPath}
                    disabled={!runtimeInfo.isInstalled || cliInstalling}
                  >
                    {cliInstalling ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </Field>
              {cliError && (
                <Alert variant="destructive">
                  <AlertDescription>{cliError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </SettingsSection>
      )}

      <SettingsSection title="About">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Launcher version</FieldLabel>
              </div>
              <span className="text-sm text-muted-foreground sm:text-xs">{launcherVersion ?? '—'}</span>
            </Field>
            <Field orientation="horizontal" className="justify-between gap-4">
              <div className="min-w-0">
                <FieldLabel>Compute</FieldLabel>
              </div>
              <span className="text-sm text-muted-foreground sm:text-xs">
                {currentProfile === 'platform' ? 'Managed' : currentProfile === 'host' ? 'None' : 'Local'}
              </span>
            </Field>
          </CardContent>
        </Card>
      </SettingsSection>
    </SettingsPane>
  );
});
SettingsModalWorkspaceTab.displayName = 'SettingsModalWorkspaceTab';
