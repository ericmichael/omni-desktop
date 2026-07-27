import type { PresenceBadgeStatus } from '@fluentui/react-components';
import { Avatar } from '@fluentui/react-components';
import { memo } from 'react';

import type { ResidentAgentRuntime } from '@/shared/types';

/** Live presence for an agent: busy while a turn runs, available when idle,
 *  offline when parked or disabled. */
export const presenceStatus = (
  state: ResidentAgentRuntime['state'] | undefined,
  enabled = true
): PresenceBadgeStatus => {
  if (!enabled) {
    return 'offline';
  }
  if (state === 'thinking' || state === 'reflecting' || state === 'starting') {
    return 'busy';
  }
  if (state === 'idle') {
    return 'available';
  }
  return 'offline';
};

/** The Agents surface's one identity mark: colorful Avatar keyed by the
 *  STABLE id (a rename keeps the color), presence composed in where live
 *  state matters. */
export const AgentAvatar = memo(function AgentAvatar({
  name,
  colorId,
  presence,
  size = 32,
}: {
  name: string;
  /** Stable color key — agent id, or the `user` participant. */
  colorId: string;
  presence?: PresenceBadgeStatus;
  size?: 20 | 24 | 28 | 32 | 36 | 40 | 48;
}): React.JSX.Element {
  return (
    <Avatar
      color="colorful"
      name={name}
      idForColor={colorId}
      size={size}
      aria-hidden="true"
      /* Below 28px Fluent auto-drops the badge to `tiny` (6px), where the
         status glyph is illegible — pin the 10px size small rows still read. */
      {...(presence ? { badge: { status: presence, ...(size < 28 ? { size: 'extra-small' as const } : {}) } } : {})}
    />
  );
});
