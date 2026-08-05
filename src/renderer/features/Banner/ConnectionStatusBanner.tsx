/**
 * App-shell banner for the backend WebSocket's lifecycle state
 * (`$wsConnectionState`). Two surfaces, per the standard lifecycle policy
 * (`@/shared/lifecycle`):
 *
 *   - retryable outage — the transport is backing off and redialing; a
 *     yellow banner says so and clears itself on reconnect. Shown from the
 *     second consecutive attempt so a single blip doesn't flash the UI.
 *   - terminal close — a deterministic rejection (44xx auth codes) or an
 *     exhausted retry budget; the transport will NOT redial. A red banner
 *     explains why and offers a reload (a fresh page re-dials with fresh
 *     credentials and a fresh budget).
 *
 * Renders nothing in standalone Electron (no WS transport) and while the
 * connection is healthy.
 */
import './Banner.css';

import { useStore } from '@nanostores/react';
import { TriangleAlert } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHENTICATED } from '@/shared/lifecycle';

import { $wsConnectionState } from './state';

export const ConnectionStatusBanner = memo(() => {
  const state = useStore($wsConnectionState);
  const handleReload = useCallback(() => {
    location.reload();
  }, []);
  if (!state) {
    return null;
  }
  // Retryable: the transport is redialing on the shared backoff schedule.
  // Attempt 1 fires within ~0.5s of the drop — suppress it to avoid a flash
  // on momentary blips (dev-server restarts, laptop lid, etc.).
  if (state.state === 'reconnecting' && state.attempt >= 2) {
    return (
      <Alert
        className="shrink-0 rounded-none border-x-0 border-t-0 border-warning/50 bg-warning/10 text-warning"
        role="status"
      >
        <TriangleAlert />
        <AlertTitle>Connection to the backend lost.</AlertTitle>
        <AlertDescription>Reconnecting (attempt {state.attempt})…</AlertDescription>
      </Alert>
    );
  }
  // Terminal: the transport gave up and will not redial on its own.
  if (state.state === 'closed' && state.permanent) {
    const authRejected = state.closeCode === WS_CLOSE_UNAUTHENTICATED || state.closeCode === WS_CLOSE_FORBIDDEN;
    return (
      <Alert
        variant="destructive"
        className="omni-status-banner-grid rounded-none border-x-0 border-t-0 border-destructive/50"
      >
        <TriangleAlert />
        <AlertTitle>Disconnected from the backend.</AlertTitle>
        <AlertDescription>
          {authRejected
            ? `Your session was rejected (code ${state.closeCode}). Sign in again, then reload.`
            : state.closeCode !== undefined
              ? `The server refused the connection (code ${state.closeCode}).`
              : 'Gave up after repeated connection failures.'}
        </AlertDescription>
        <Button className="col-start-3 row-span-2 row-start-1" size="sm" variant="ghost" onClick={handleReload}>
          Reload
        </Button>
      </Alert>
    );
  }
  return null;
});

ConnectionStatusBanner.displayName = 'ConnectionStatusBanner';
