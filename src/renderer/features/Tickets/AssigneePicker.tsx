import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components';
import { Person20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect } from 'react';

import { Button } from '@/renderer/ds';
import { $members, loadMembers } from '@/renderer/features/Teams/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { TeamMember, TicketId } from '@/shared/types';

/**
 * Assign a ticket to a team member, or leave it Unassigned (the default).
 * Ownership stays with the team — this only sets the optional `assignee` pointer
 * that drives the "my work" filters. Any team member may reassign. In single-
 * user/local mode the member list is empty, so the only option is Unassigned.
 */
export const AssigneePicker = memo(function AssigneePicker({
  ticketId,
  assignee,
}: {
  ticketId: TicketId;
  assignee?: string;
}) {
  const members = useStore($members);

  useEffect(() => {
    // Refresh the roster when the picker mounts (cheap; no-op without teams).
    if (members.length === 0) void loadMembers();
  }, [members.length]);

  const handleUnassign = useCallback(() => void ticketApi.assignTicket(ticketId, null), [ticketId]);
  const handleAssign = useCallback(
    (userId: string) => () => void ticketApi.assignTicket(ticketId, userId),
    [ticketId]
  );

  const current = members.find((m) => m.userId === assignee);
  const label = current ? memberLabel(current) : assignee ? assignee : 'Unassigned';

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="sm" variant="ghost" leftIcon={<Person20Regular />} aria-label="Assign ticket">
          {label}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={handleUnassign}>Unassigned</MenuItem>
          {members.map((m) => (
            <MenuItem key={m.userId} onClick={handleAssign(m.userId)}>
              {memberLabel(m)}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});

function memberLabel(m: TeamMember): string {
  return m.displayName ?? m.email ?? m.userId;
}
