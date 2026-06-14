import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components';
import { Filter20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds';
import { $currentPrincipal, $members } from '@/renderer/features/Teams/state';
import { $assigneeFilter } from '@/renderer/features/Tickets/state';

/**
 * Filter the board by assignee (teams). Hidden in single-user/local mode (no
 * roster). "Me" uses the current principal; ownership is unaffected — this is
 * purely a view filter.
 */
export const AssigneeFilter = memo(function AssigneeFilter() {
  const members = useStore($members);
  const filter = useStore($assigneeFilter);
  const me = useStore($currentPrincipal);

  const setAll = useCallback(() => $assigneeFilter.set('all'), []);
  const setMine = useCallback(() => $assigneeFilter.set('me'), []);
  const setUnassigned = useCallback(() => $assigneeFilter.set('unassigned'), []);
  const setMember = useCallback((id: string) => () => $assigneeFilter.set(id), []);

  // No teams → nothing to filter by.
  if (members.length === 0) {
    return null;
  }

  const label =
    filter === 'all'
      ? 'All assignees'
      : filter === 'me'
        ? 'Assigned to me'
        : filter === 'unassigned'
          ? 'Unassigned'
          : (members.find((m) => m.userId === filter)?.displayName ??
            members.find((m) => m.userId === filter)?.email ??
            'Assignee');

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="sm" variant="ghost" leftIcon={<Filter20Regular />}>
          {label}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={setAll}>All assignees</MenuItem>
          {me ? <MenuItem onClick={setMine}>Assigned to me</MenuItem> : null}
          <MenuItem onClick={setUnassigned}>Unassigned</MenuItem>
          {members.map((m) => (
            <MenuItem key={m.userId} onClick={setMember(m.userId)}>
              {m.displayName ?? m.email ?? m.userId}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});
