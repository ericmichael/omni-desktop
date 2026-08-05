import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Resolve a portal host by id and follow it when its owning layout replaces the
 * DOM node without changing the id. The ref guard is intentionally checked
 * before setState so DOM mutations caused by the portal itself cannot schedule
 * a render loop.
 */
export function usePortalTarget(targetId: string | undefined): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const resolveTarget = () => {
      const nextTarget = targetId ? document.getElementById(targetId) : null;
      if (targetRef.current === nextTarget) {
        return;
      }

      targetRef.current = nextTarget;
      setTarget(nextTarget);
    };

    resolveTarget();

    if (!targetId) {
      return;
    }

    const observer = new MutationObserver(resolveTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [targetId]);

  return target;
}
