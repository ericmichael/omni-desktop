import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button, FormField } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import {
  $omniInstallProcessStatus,
  $omniRuntimeInfo,
  $sandboxProcessStatus,
  omniInstallApi,
  sandboxApi,
} from '@/renderer/features/Omni/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi, selectWorkspaceDir } from '@/renderer/services/store';
import type { OmniTheme, SandboxVariant } from '@/shared/types';

export const SettingsModalOmniSandboxOptions = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);
  const installStatus = useStore($omniInstallProcessStatus);
  const sandboxStatus = useStore($sandboxProcessStatus);
  const launcherVersion = useStore($launcherVersion);

  const isInstalling = installStatus.type === 'starting' || installStatus.type === 'installing';
  const isRebuilding = sandboxStatus.type === 'starting' || sandboxStatus.type === 'stopping';

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

  const onChangeSandboxVariant = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    persistedStoreApi.setKey('sandboxVariant', e.target.value as SandboxVariant);
  }, []);

  const rebuildDockerImage = useCallback(() => {
    sandboxApi.rebuild();
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
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Sandbox</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Sandbox variant">
          <select
            value={store.sandboxVariant ?? 'work'}
            onChange={onChangeSandboxVariant}
            className="h-8 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
          >
            <option value="work">Work</option>
            <option value="standard">Standard</option>
          </select>
        </FormField>
        {(import.meta.env.MODE === 'development' || store.previewFeatures) && (
          <FormField label="Rebuild Docker image">
            <Button size="sm" variant="ghost" onClick={rebuildDockerImage} isDisabled={isRebuilding}>
              {isRebuilding ? 'Rebuilding\u2026' : 'Rebuild'}
            </Button>
          </FormField>
        )}
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Display</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Theme">
          <select
            value={store.theme ?? 'tokyo-night'}
            onChange={onChangeTheme}
            className="h-8 px-2 text-xs rounded-md bg-surface border border-surface-border/50 text-fg cursor-pointer outline-none focus:border-accent-500/50"
          >
            <option value="default">Default</option>
            <option value="tokyo-night">Tokyo Night</option>
            <option value="vscode-dark">VS Code Dark</option>
            <option value="vscode-light">VS Code Light</option>
            <option value="utrgv">UTRGV</option>
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
        {cliError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{cliError}</div>
        )}
      </div>

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">About</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label="Launcher version">
          <span className="text-xs text-fg-muted">{launcherVersion ?? '—'}</span>
        </FormField>
      </div>
    </div>
  );
});

SettingsModalOmniSandboxOptions.displayName = 'SettingsModalOmniSandboxOptions';
