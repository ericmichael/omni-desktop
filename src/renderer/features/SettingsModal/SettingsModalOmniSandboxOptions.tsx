import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button, FormField, Switch } from '@/renderer/ds';
import { $omniInstallProcessStatus, $omniRuntimeInfo, omniInstallApi } from '@/renderer/features/Omni/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi, selectEnvFilePath, selectWorkspaceDir } from '@/renderer/services/store';
import type { OmniTheme } from '@/shared/types';

export const SettingsModalOmniSandboxOptions = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);
  const installStatus = useStore($omniInstallProcessStatus);

  const isInstalling = installStatus.type === 'starting' || installStatus.type === 'installing';

  const [cliInPath, setCliInPath] = useState<{ installed: boolean; symlinkPath: string } | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);

  const checkCliStatus = useCallback(async () => {
    const status = await emitter.invoke('util:get-cli-in-path-status');
    setCliInPath(status);
  }, []);

  useEffect(() => {
    checkCliStatus();
  }, [checkCliStatus, runtimeInfo]);

  const installCliToPath = useCallback(async () => {
    setCliInstalling(true);
    try {
      const result = await emitter.invoke('util:install-cli-to-path');
      if (!result.success) {
        console.error('Failed to install CLI to PATH:', result.error);
      }
      await checkCliStatus();
    } finally {
      setCliInstalling(false);
    }
  }, [checkCliStatus]);

  const onChangeCodeServer = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('enableCodeServer', checked);
  }, []);

  const onChangeVnc = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('enableVnc', checked);
  }, []);

  const onChangeWorkDockerfile = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('useWorkDockerfile', checked);
  }, []);

  const clearEnvFilePath = useCallback(() => {
    persistedStoreApi.setKey('envFilePath', undefined);
  }, []);

  const reinstallRuntime = useCallback(() => {
    omniInstallApi.startInstall(true);
  }, []);

  const onChangeTheme = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('theme', e.target.value as OmniTheme);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Workspace</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Workspace directory">
          <span className="text-xs text-fg-muted truncate max-w-[200px]">{store.workspaceDir ?? 'Default'}</span>
          <Button size="sm" variant="ghost" onClick={selectWorkspaceDir}>
            Change
          </Button>
        </FormField>
        <FormField label="Environment file">
          <span className="text-xs text-fg-muted truncate max-w-[200px]">{store.envFilePath ?? 'None'}</span>
          <Button size="sm" variant="ghost" onClick={selectEnvFilePath}>
            Change
          </Button>
          {store.envFilePath && (
            <Button size="sm" variant="ghost" onClick={clearEnvFilePath}>
              Clear
            </Button>
          )}
        </FormField>
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Services</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Enable code-server">
          <Switch checked={store.enableCodeServer} onCheckedChange={onChangeCodeServer} />
        </FormField>
        <FormField label="Enable desktop (noVNC)">
          <Switch checked={store.enableVnc} onCheckedChange={onChangeVnc} />
        </FormField>
        <FormField label="Use Dockerfile.work">
          <Switch checked={store.useWorkDockerfile} onCheckedChange={onChangeWorkDockerfile} />
        </FormField>
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Display</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Theme">
          <select
            value={store.theme ?? 'tokyo-night'}
            onChange={onChangeTheme}
            className="h-8 px-2 text-xs rounded-md bg-transparent border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
          >
            <option value="default">Default</option>
            <option value="tokyo-night">Tokyo Night</option>
            <option value="vscode-dark">VS Code Dark</option>
            <option value="vscode-light">VS Code Light</option>
          </select>
        </FormField>
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Runtime</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
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
            <span className="text-xs text-fg-muted">Installed</span>
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
      </div>
    </div>
  );
});

SettingsModalOmniSandboxOptions.displayName = 'SettingsModalOmniSandboxOptions';
