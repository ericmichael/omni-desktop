import { PanelLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/renderer/ds/ui/button';

type HeaderActionsContextValue = {
  showArtifactsButton: boolean;
  onArtifactsToggle?: () => void;
};

const HeaderActionsContext = createContext<HeaderActionsContextValue | null>(null);

export const OmniAgentsHeaderActionsProvider = ({
  showArtifactsButton,
  onArtifactsToggle,
  children,
}: HeaderActionsContextValue & { children: ReactNode }) => {
  const value = useMemo(
    () => ({
      showArtifactsButton,
      onArtifactsToggle,
    }),
    [showArtifactsButton, onArtifactsToggle]
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
  const { showArtifactsButton, onArtifactsToggle } = useHeaderActions();
  const sizeClass = compact ? 'size-8' : 'size-9';

  return (
    <div className="flex items-center gap-1">
      {showArtifactsButton && onArtifactsToggle ? (
        <Button
          variant="ghost"
          size={compact ? 'icon-sm' : 'icon'}
          className={sizeClass}
          onClick={onArtifactsToggle}
          aria-label="Toggle artifacts"
          type="button"
        >
          <PanelLeft />
        </Button>
      ) : null}
    </div>
  );
};

const targets = new Map<string, HTMLDivElement>();
const targetListeners = new Set<() => void>();
const subscribeTargets = (listener: () => void) => {
  targetListeners.add(listener);
  return () => {
    targetListeners.delete(listener);
  };
};

/** Header lifetime is independent of the persistent chat portal's lifetime. */
export function OmniAgentsHeaderActionsSlot({ id }: { id: string }) {
  const current = useRef<HTMLDivElement | null>(null);
  const register = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) {
        targets.set(id, element);
      } else if (targets.get(id) === current.current) {
        targets.delete(id);
      }
      current.current = element;
      targetListeners.forEach((listener) => listener());
    },
    [id]
  );
  return <div id={id} ref={register} />;
}

export const OmniAgentsHeaderActionsPortal = ({ targetId, compact }: { targetId: string; compact?: boolean }) => {
  const target = useSyncExternalStore(
    subscribeTargets,
    () => targets.get(targetId) ?? null,
    () => null
  );
  if (!target) {
    return null;
  }
  return createPortal(<OmniAgentsHeaderActions compact={compact} />, target);
};
