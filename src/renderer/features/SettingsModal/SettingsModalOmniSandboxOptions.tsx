import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Button, FormField, Switch } from '@/renderer/ds';
import { $omniRuntimeInfo, omniInstallApi } from '@/renderer/features/Omni/state';
import { persistedStoreApi, selectEnvFilePath, selectWorkspaceDir } from '@/renderer/services/store';

export const SettingsModalOmniSandboxOptions = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);

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

      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle mt-2">Runtime</span>
      <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-4 flex flex-col gap-3">
        <FormField label={`Runtime${runtimeInfo.isInstalled ? ` (v${runtimeInfo.version})` : ''}`}>
          <Button size="sm" variant="ghost" onClick={reinstallRuntime}>
            {runtimeInfo.isInstalled ? 'Reinstall' : 'Install'}
          </Button>
        </FormField>
      </div>
    </div>
  );
});

SettingsModalOmniSandboxOptions.displayName = 'SettingsModalOmniSandboxOptions';
