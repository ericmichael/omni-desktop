import { Filter20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { residentPrincipalId } from '@/lib/resident-agent';
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
import { persistedStoreApi } from '@/renderer/services/store';

/**
 * Filter the board by assignee: human members (teams) and resident agents.
 * Hidden when both rosters are empty. "Me" uses the current principal;
 * ownership is unaffected — this is purely a view filter.
 */
export const AssigneeFilter = memo(function AssigneeFilter() {
  const members = useStore($members);
  const filter = useStore($assigneeFilter);
  const me = useStore($currentPrincipal);
  const residents = useStore(persistedStoreApi.$atom).residentAgents.filter((a) => a.enabled);

  const handleCheckedChange = useCallback((_e: unknown, data: MenuCheckedValueChangeData) => {
    if (data.name === 'assignee') {
      $assigneeFilter.set(data.checkedItems[0] ?? 'all');
    }
  }, []);

  // Nobody to filter by.
  if (members.length === 0 && residents.length === 0) {
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
            residents.find((a) => residentPrincipalId(a.id) === filter)?.name ??
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
          {members.length > 0 && <MenuDivider />}
          {members.map((m) => (
            <MenuItemRadio key={m.userId} name="assignee" value={m.userId}>
              {m.displayName ?? m.email ?? m.userId}
            </MenuItemRadio>
          ))}
          {residents.length > 0 && <MenuDivider />}
          {residents.map((a) => (
            <MenuItemRadio key={a.id} name="assignee" value={residentPrincipalId(a.id)}>
              {a.name}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});
