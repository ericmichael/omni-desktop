import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components';
import { Checkmark16Regular, People20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds';
import { $activeTeamId, $teams, switchTeam } from '@/renderer/features/Teams/state';

/**
 * Always-visible active-team indicator + quick switcher. Renders only when the
 * user is in more than one team (or any shared team) — solo users on a single
 * personal team see nothing, keeping the personal-first experience clean.
 */
export const TeamSwitcher = memo(function TeamSwitcher() {
  const teams = useStore($teams);
  const activeTeamId = useStore($activeTeamId);

  const handleSwitch = useCallback((id: string) => () => switchTeam(id), []);

  const multi = teams.length > 1 || teams.some((t) => t.kind === 'shared');
  if (!multi) return null;

  const active = teams.find((t) => t.id === activeTeamId);

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="sm" variant="ghost" leftIcon={<People20Regular />} aria-label="Switch team">
          {active?.label ?? 'Team'}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {teams.map((t) => (
            <MenuItem
              key={t.id}
              icon={t.id === activeTeamId ? <Checkmark16Regular /> : <span style={{ width: 16 }} />}
              onClick={handleSwitch(t.id)}
            >
              {t.label}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});
