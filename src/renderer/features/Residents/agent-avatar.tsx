import type { PresenceBadgeStatus } from '@fluentui/react-components';
import { Avatar } from '@fluentui/react-components';
import { memo } from 'react';

import type { ResidentAgent, ResidentAgentRuntime } from '@/shared/types';

/** The presence values agent surfaces can show — the product has no "away"
 *  or "out of office" for agents, so the type pins the three we derive. */
export type AgentPresence = Extract<PresenceBadgeStatus, 'available' | 'busy' | 'offline'>;

/**
 * Live presence for an agent — the ONE mapping from runtime state to badge,
 * shared by every avatar surface.
 *
 *   disabled (`enabled === false`)        → offline
 *   starting / thinking / reflecting      → busy       (a turn is running)
 *   idle                                  → available  (live, waiting)
 *   parked, or no runtime entry yet       → offline
 *
 * The last row is why an unknown agent reads as offline rather than as a
 * fourth state: a resident with no `$residentStatus` entry has no running
 * process, which is exactly what `parked` means. Splitting them apart would
 * be a change to presence *detection*, not to how presence is presented.
 */
export const presenceStatus = (state: ResidentAgentRuntime['state'] | undefined, enabled = true): AgentPresence => {
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

/**
 * Presence for one participant id, or `undefined` when the participant is not
 * a live agent identity — `user`, `system`, or an agent that has left the
 * roster. Feeds and typeaheads resolve every avatar through here so a
 * non-agent avatar never grows a status dot.
 */
export const participantPresence = (
  participantId: string,
  roster: ReadonlyArray<ResidentAgent>,
  statuses: Readonly<Record<string, ResidentAgentRuntime>>
): AgentPresence | undefined => {
  const agent = roster.find((a) => a.id === participantId);
  return agent ? presenceStatus(statuses[participantId]?.state, agent.enabled) : undefined;
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
  presence?: AgentPresence;
  size?: 20 | 24 | 28 | 32 | 36 | 40 | 48;
}): React.JSX.Element {
  return (
    <Avatar
      color="colorful"
      name={name}
      idForColor={colorId}
      size={size}
      /* A presence-less avatar always sits beside its own name, so it stays
         decorative. With a badge the avatar becomes the ONLY carrier of
         status, so it must stay exposed: Fluent then labels the root
         `<name> <status>` via aria-labelledby, and the badge draws a distinct
         glyph per status at every size — status is never colour alone. */
      {...(presence
        ? {
            badge: {
              status: presence,
              /* Below 28px Fluent auto-drops the badge to `tiny` (6px), where
                 the status glyph is illegible — pin the 10px size small rows
                 still read, without swallowing the avatar. */
              ...(size < 28 ? { size: 'extra-small' as const } : {}),
            },
          }
        : { 'aria-hidden': 'true' as const })}
    />
  );
});
