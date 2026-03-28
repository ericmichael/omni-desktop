import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { createPortal } from 'react-dom';

type HeaderActionsContextValue = {
  showTerminalButton: boolean;
  showArtifactsButton: boolean;
  onTerminalToggle?: () => void;
  onArtifactsToggle?: () => void;
};

const HeaderActionsContext = createContext<HeaderActionsContextValue | null>(null);

export const OmniAgentsHeaderActionsProvider = ({
  showTerminalButton,
  showArtifactsButton,
  onTerminalToggle,
  onArtifactsToggle,
  children,
}: HeaderActionsContextValue & { children: ReactNode }) => {
  const value = useMemo(
    () => ({
      showTerminalButton,
      showArtifactsButton,
      onTerminalToggle,
      onArtifactsToggle,
    }),
    [showArtifactsButton, showTerminalButton, onArtifactsToggle, onTerminalToggle]
  );

  return <HeaderActionsContext.Provider value={value}>{children}</HeaderActionsContext.Provider>;
};

const useHeaderActions = () => {
  const ctx = useContext(HeaderActionsContext);
  if (!ctx) {
    throw new Error('OmniAgentsHeaderActionsProvider is missing');
  }
  return ctx;
};

export const OmniAgentsHeaderActions = ({ compact = false }: { compact?: boolean }) => {
  const { showArtifactsButton, showTerminalButton, onArtifactsToggle, onTerminalToggle } = useHeaderActions();
  const sizeClass = compact ? 'size-7' : 'size-8';

  return (
    <div className="flex items-center gap-1">
      {showTerminalButton && onTerminalToggle ? (
        <button
          className={`${sizeClass} rounded hover:bg-bgCardAlt text-textPrimary flex items-center justify-center`}
          onClick={onTerminalToggle}
          aria-label="Toggle terminal"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 17l6-6-6-6" />
            <path d="M12 19h8" />
          </svg>
        </button>
      ) : null}
      {showArtifactsButton && onArtifactsToggle ? (
        <button
          className={`${sizeClass} rounded hover:bg-bgCardAlt text-textPrimary flex items-center justify-center`}
          onClick={onArtifactsToggle}
          aria-label="Toggle artifacts"
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
};

export const OmniAgentsHeaderActionsPortal = ({ targetId, compact }: { targetId: string; compact?: boolean }) => {
  const target = typeof document !== 'undefined' ? document.getElementById(targetId) : null;
  if (!target) {
    return null;
  }
  return createPortal(<OmniAgentsHeaderActions compact={compact} />, target);
};
