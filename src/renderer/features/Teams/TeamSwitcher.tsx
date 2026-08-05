import { useStore } from '@nanostores/react';
import { Check, Users } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
/**
 * Always-visible active-team indicator + quick switcher. Renders only when the
 * user is in more than one team (or any shared team) — solo users on a single
 * personal team see nothing, keeping the personal-first experience clean.
 */ import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { $activeTeamId, $teams, switchTeam } from '@/renderer/features/Teams/state';
export const TeamSwitcher = memo(function TeamSwitcher() {
  const teams = useStore($teams);
  const activeTeamId = useStore($activeTeamId);

  const handleSwitch = useCallback((id: string) => () => switchTeam(id), []);

  const multi = teams.length > 1 || teams.some((t) => t.kind === 'shared');
  if (!multi) {
    return null;
  }

  const active = teams.find((t) => t.id === activeTeamId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Switch team">
          <Users />
          {active?.label ?? 'Team'}
        </Button>
      </DropdownMenuTrigger>
      <>
        <DropdownMenuContent>
          {teams.map((t) => (
            <DropdownMenuItem key={t.id} onClick={handleSwitch(t.id)}>
              {t.id === activeTeamId ? <Check /> : <span className="w-4" />}
              {t.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </>
    </DropdownMenu>
  );
});
