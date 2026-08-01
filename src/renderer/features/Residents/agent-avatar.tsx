import type { PresenceBadgeStatus } from '@fluentui/react-components';
import { Avatar, AvatarGroup, AvatarGroupItem, makeStyles } from '@fluentui/react-components';
import { memo } from 'react';

import type { ResidentAgent, ResidentAgentRuntime } from '@/shared/types';

const useStyles = makeStyles({
  /** Off-screen but announced — the presence dot's text equivalent. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    border: 'none',
  },
});

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

/** Spoken form of each presence — Fluent's own PresenceBadge wording, so the
 *  text equivalent matches what the glyph means. */
export const PRESENCE_LABEL: Record<AgentPresence, string> = {
  available: 'available',
  busy: 'busy',
  offline: 'offline',
};

export type AvatarSize = 20 | 24 | 28 | 32 | 36 | 40 | 48;

/**
 * The badge slot shared by every agent avatar. Below 28px Fluent auto-drops
 * the badge to `tiny`, whose 6px box crops the glyph down to a bare dot — pin
 * `extra-small`, whose 10px box shows the whole shape, so small rows still
 * read a status rather than just a colour. (Both sizes ship the SAME 10px SVG;
 * only the badge box and its cutout differ.)
 *
 * An omitted `size` also pins, rather than falling through to Fluent: the
 * resolved size then comes from an ambient `AvatarContextProvider` that this
 * helper cannot see, and every context in the app is a compact slot
 * (`InteractionTag` publishes 16/20/28, all of which want `extra-small` or
 * smaller). Guessing `extra-small` there can only ever raise a 6px badge, never
 * shrink a correct one.
 */
const presenceBadge = (presence: AgentPresence, size: AvatarSize | undefined) => ({
  status: presence,
  ...(size === undefined || size < 28 ? { size: 'extra-small' as const } : {}),
});

/**
 * The Agents surface's one identity mark: colorful Avatar keyed by the STABLE
 * id (a rename keeps the color), presence composed in where live state
 * matters.
 *
 * Accessibility: the avatar itself is ALWAYS decorative — every surface
 * renders the agent's name as text right beside it, and an exposed Avatar
 * folds both its name and its badge into the enclosing row's
 * name-from-content ("Ada Lovelace busy Ada Lovelace Engineer"). Instead the
 * mark stays `aria-hidden` and the status is announced exactly once, by the
 * off-screen sibling below, which lands inside the row's own label. Sighted
 * users get the same information from the badge glyph, which differs in SHAPE
 * per status at every size — never colour alone.
 *
 * `size` is deliberately un-defaulted: Fluent resolves `props.size ??
 * avatarContextSize ?? 32`, so a hardcoded default would beat the
 * `AvatarContextProvider` that slots like `InteractionTagPrimary` publish and
 * blow the avatar out of its container.
 */
export const AgentAvatar = memo(function AgentAvatar({
  name,
  colorId,
  presence,
  size,
}: {
  name: string;
  /** Stable color key — agent id, or the `user` participant. */
  colorId: string;
  presence?: AgentPresence;
  /** Omit to inherit an ambient Fluent avatar context (slot media, etc). */
  size?: AvatarSize;
}): React.JSX.Element {
  const styles = useStyles();
  return (
    <>
      <Avatar
        color="colorful"
        name={name}
        idForColor={colorId}
        aria-hidden="true"
        {...(size !== undefined ? { size } : {})}
        {...(presence ? { badge: presenceBadge(presence, size) } : {})}
      />
      {presence ? <span className={styles.srOnly}>{PRESENCE_LABEL[presence]}</span> : null}
    </>
  );
});

/**
 * Two-agent identity (an observed agent↔agent DM). `spread`, never `stack`:
 * stacked items carry a negative left margin that clips the leading avatar's
 * badge, and the whole point here is that both agents' presence is readable.
 * Same decorative-mark + one off-screen status rule as `AgentAvatar`, except
 * the status text names each agent — with two of them, "busy" alone would not
 * say whose.
 */
export const AgentAvatarGroup = memo(function AgentAvatarGroup({
  avatars,
  size = 24,
}: {
  avatars: ReadonlyArray<{ name: string; colorId: string; presence?: AgentPresence }>;
  size?: AvatarSize;
}): React.JSX.Element {
  const styles = useStyles();
  const spoken = avatars.flatMap((a) => (a.presence ? [`${a.name} ${PRESENCE_LABEL[a.presence]}`] : []));
  return (
    <>
      <AvatarGroup layout="spread" size={size} aria-hidden="true">
        {avatars.map((a) => (
          <AvatarGroupItem
            key={a.colorId}
            color="colorful"
            name={a.name}
            idForColor={a.colorId}
            {...(a.presence ? { badge: presenceBadge(a.presence, size) } : {})}
          />
        ))}
      </AvatarGroup>
      {spoken.length > 0 ? <span className={styles.srOnly}>{spoken.join(', ')}</span> : null}
    </>
  );
});
