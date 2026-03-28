import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';

import { App as OmniAgentsCore } from './App';
import type { PendingMessage } from './ChatShell';
import './styles/index.css';
import { UiConfigProvider, useUiConfig } from './ui-config';

type OmniAgentsAppProps = {
  uiUrl: string;
  greeting?: string;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  pendingMessages?: PendingMessage[];
};

const ThemeSync = ({ children }: { children: ReactNode }) => {
  const { theme } = useUiConfig();

  useEffect(() => {
    if (!theme || theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
      return;
    }
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return <>{children}</>;
};

export const OmniAgentsApp = ({ uiUrl, greeting, onReady, headerActionsTargetId, headerActionsCompact, pendingMessages }: OmniAgentsAppProps) => {
  const normalizedUrl = useMemo(() => new URL(uiUrl, window.location.origin).toString(), [uiUrl]);

  return (
    <UiConfigProvider uiUrl={normalizedUrl}>
      <ThemeSync>
        <OmniAgentsCore greeting={greeting} onReady={onReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} pendingMessages={pendingMessages} />
      </ThemeSync>
    </UiConfigProvider>
  );
};
