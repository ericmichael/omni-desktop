import { Filter20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import {
  Button,
  Menu,
  type MenuCheckedValueChangeData,
  MenuDivider,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
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

  const handleCheckedChange = useCallback((_e: unknown, data: MenuCheckedValueChangeData) => {
    if (data.name === 'assignee') {
      $assigneeFilter.set(data.checkedItems[0] ?? 'all');
    }
  }, []);

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
    <Menu checkedValues={{ assignee: [filter] }} onCheckedValueChange={handleCheckedChange}>
      <MenuTrigger disableButtonEnhancement>
        <Button size="sm" variant="ghost" leftIcon={<Filter20Regular />}>
          {label}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemRadio name="assignee" value="all">
            All assignees
          </MenuItemRadio>
          {me ? (
            <MenuItemRadio name="assignee" value="me">
              Assigned to me
            </MenuItemRadio>
          ) : null}
          <MenuItemRadio name="assignee" value="unassigned">
            Unassigned
          </MenuItemRadio>
          <MenuDivider />
          {members.map((m) => (
            <MenuItemRadio key={m.userId} name="assignee" value={m.userId}>
              {m.displayName ?? m.email ?? m.userId}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});
