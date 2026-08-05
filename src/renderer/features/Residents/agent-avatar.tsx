import { CheckIcon, LoaderCircleIcon, MinusIcon } from 'lucide-react';
import { memo } from 'react';

import { Avatar, AvatarFallback } from '@/renderer/ds/ui/avatar';
import type { ResidentAgent, ResidentAgentRuntime } from '@/shared/types';

/** The presence values agent surfaces can show — the product has no "away"
 *  or "out of office" for agents, so the type pins the three we derive. */
export type AgentPresence = 'available' | 'busy' | 'offline';

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

/** Spoken form of each presence. */
export const PRESENCE_LABEL: Record<AgentPresence, string> = {
  available: 'available',
  busy: 'busy',
  offline: 'offline',
};

export type AvatarSize = 20 | 24 | 28 | 32 | 36 | 40 | 48;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const avatarHue = (key: string) => [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;

export const AgentPresenceBadge = ({ presence }: { presence: AgentPresence }) => {
  const Icon = presence === 'available' ? CheckIcon : presence === 'busy' ? LoaderCircleIcon : MinusIcon;
  const color = presence === 'available' ? 'bg-success' : presence === 'busy' ? 'bg-warning' : 'bg-muted-foreground';
  return (
    <span
      data-slot="presence-badge"
      aria-label={presence}
      className={`inline-flex size-2.5 items-center justify-center rounded-full text-primary-foreground ${color}`}
    >
      <Icon className="size-2" aria-hidden="true" />
    </span>
  );
};

/**
 * The Agents surface's one identity mark: colorful avatar keyed by the stable
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
  /** Omit to use the default avatar size. */
  size?: AvatarSize;
}): React.JSX.Element {
  const sizeClass = {
    20: 'size-5',
    24: 'size-6',
    28: 'size-7',
    32: 'size-8',
    36: 'size-9',
    40: 'size-10',
    48: 'size-12',
  }[size ?? 32];

  return (
    <>
      <span data-slot="avatar-shell" className="relative inline-flex shrink-0" aria-hidden="true">
        <Avatar className={sizeClass}>
          <AvatarFallback
            className="text-primary-foreground"
            style={{ backgroundColor: `hsl(${avatarHue(colorId)} 65% 45%)` }}
          >
            {initials(name)}
          </AvatarFallback>
        </Avatar>
        {presence && (
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-background">
            <AgentPresenceBadge presence={presence} />
          </span>
        )}
      </span>
      {presence ? <span className="sr-only">{PRESENCE_LABEL[presence]}</span> : null}
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
  const spoken = avatars.flatMap((a) => (a.presence ? [`${a.name} ${PRESENCE_LABEL[a.presence]}`] : []));
  return (
    <>
      <div className="flex gap-1" aria-hidden="true">
        {avatars.map((a) => (
          <AgentAvatar key={a.colorId} name={a.name} colorId={a.colorId} presence={a.presence} size={size} />
        ))}
      </div>
      {spoken.length > 0 ? <span className="sr-only">{spoken.join(', ')}</span> : null}
    </>
  );
});
