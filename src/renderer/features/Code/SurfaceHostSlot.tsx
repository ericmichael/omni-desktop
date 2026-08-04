import { memo, useCallback } from 'react';

/** Adopts exactly one persistent surface host into the currently visible dock slot. */
export const SurfaceHostSlot = memo(({ host }: { host: HTMLDivElement }) => {
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) {
        // React can reuse this slot while the selected dock app changes. An
        // append would retain the previous host and render Files and Git in
        // the same container; replacement makes host ownership exclusive.
        element.replaceChildren(host);
      }
    },
    [host]
  );
  return <div ref={ref} style={{ width: '100%', height: '100%', minHeight: 0 }} />;
});
SurfaceHostSlot.displayName = 'SurfaceHostSlot';
