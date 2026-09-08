import { useStore } from '@nanostores/react';
import type { PropsWithChildren } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';
import { assert } from 'tsafe';

import { LoaderFullScreen } from '@/renderer/common/LoaderFullScreen';
import { StartupError } from '@/renderer/common/StartupError';
import { $initializationError, $initialized, $operatingSystem } from '@/renderer/services/store';
import type { OperatingSystem } from '@/shared/types';

type SystemInfo = {
  operatingSystem?: OperatingSystem;
  initialized: boolean;
  error: string | null;
};

const SystemInfoContext = createContext<SystemInfo>({ initialized: false, error: null });

const isCtxReady = (ctx: SystemInfo): ctx is Required<SystemInfo> => {
  return ctx.operatingSystem !== undefined && ctx.initialized === true && ctx.error === null;
};

export const SystemInfoProvider = memo((props: PropsWithChildren) => {
  const operatingSystem = useStore($operatingSystem);
  const initialized = useStore($initialized);
  const error = useStore($initializationError);

  const systemInfo = useMemo<SystemInfo>(
    () => ({ operatingSystem, initialized, error }),
    [initialized, operatingSystem, error]
  );

  return <SystemInfoContext.Provider value={systemInfo}>{props.children}</SystemInfoContext.Provider>;
});
SystemInfoProvider.displayName = 'SystemInfoProvider';

export const SystemInfoLoadingGate = memo((props: PropsWithChildren) => {
  const ctx = useContext(SystemInfoContext);
  if (ctx.error) {
    return <StartupError title="Unable to start Omni" error={ctx.error} />;
  }
  if (!isCtxReady(ctx)) {
    return <LoaderFullScreen />;
  }
  return props.children;
});
SystemInfoLoadingGate.displayName = 'SystemInfoGate';

export const useSystemInfo = () => {
  const ctx = useContext(SystemInfoContext);
  assert(isCtxReady(ctx), 'SystemInfo not ready. Did you forget to wrap your component with SystemInfoGate?');
  return ctx;
};
