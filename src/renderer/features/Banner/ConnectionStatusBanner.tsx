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
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Warning20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Button, Caption1 } from '@/renderer/ds';
import { WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHENTICATED } from '@/shared/lifecycle';

import { $wsConnectionState } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground1,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorPaletteYellowBorder1),
    flexShrink: 0,
  },
  terminal: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorPaletteRedBorder1),
  },
  body: { flex: '1 1 0', minWidth: 0 },
});

export const ConnectionStatusBanner = memo(() => {
  const styles = useStyles();
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
      <div className={styles.root} role="status">
        <Warning20Filled />
        <div className={styles.body}>
          <strong>Connection to the backend lost.</strong>{' '}
          <Caption1 as="span">Reconnecting (attempt {state.attempt})…</Caption1>
        </div>
      </div>
    );
  }
  // Terminal: the transport gave up and will not redial on its own.
  if (state.state === 'closed' && state.permanent) {
    const authRejected = state.closeCode === WS_CLOSE_UNAUTHENTICATED || state.closeCode === WS_CLOSE_FORBIDDEN;
    return (
      <div className={`${styles.root} ${styles.terminal}`} role="alert">
        <Warning20Filled />
        <div className={styles.body}>
          <strong>Disconnected from the backend.</strong>{' '}
          <Caption1 as="span">
            {authRejected
              ? `Your session was rejected (code ${state.closeCode}). Sign in again, then reload.`
              : state.closeCode !== undefined
                ? `The server refused the connection (code ${state.closeCode}).`
                : 'Gave up after repeated connection failures.'}
          </Caption1>
        </div>
        <Button size="sm" variant="ghost" onClick={handleReload}>
          Reload
        </Button>
      </div>
    );
  }
  return null;
});

ConnectionStatusBanner.displayName = 'ConnectionStatusBanner';
