import { Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components';
import { Bot20Regular, Person20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect } from 'react';

import { residentPrincipalId } from '@/lib/resident-agent';
import { Button } from '@/renderer/ds';
import { $members, loadMembers } from '@/renderer/features/Teams/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { TeamMember, TicketId } from '@/shared/types';

/**
 * Assign a ticket to a team member or a resident agent, or leave it
 * Unassigned (the default). Ownership stays with the team — this only sets
 * the optional `assignee` pointer that drives the "my work" filters and, for
 * residents (`agent:<id>`), the assignment wakeup. Any team member may
 * reassign. In single-user/local mode the member list is empty, so the
 * options are Unassigned + the resident roster.
 */
export const AssigneePicker = memo(function AssigneePicker({
  ticketId,
  assignee,
}: {
  ticketId: TicketId;
  assignee?: string;
}) {
  const members = useStore($members);
  const residents = useStore(persistedStoreApi.$atom).residentAgents.filter((a) => a.enabled);

  useEffect(() => {
    // Refresh the roster when the picker mounts (cheap; no-op without teams).
    if (members.length === 0) {
      void loadMembers();
    }
  }, [members.length]);

  const handleUnassign = useCallback(() => void ticketApi.assignTicket(ticketId, null), [ticketId]);
  const handleAssign = useCallback((userId: string) => () => void ticketApi.assignTicket(ticketId, userId), [ticketId]);

  const currentMember = members.find((m) => m.userId === assignee);
  const currentResident = residents.find((a) => residentPrincipalId(a.id) === assignee);
  const label = currentMember
    ? memberLabel(currentMember)
    : currentResident
      ? currentResident.name
      : assignee
        ? assignee
        : 'Unassigned';

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={currentResident ? <Bot20Regular /> : <Person20Regular />}
          aria-label="Assign ticket"
        >
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
          {residents.length > 0 && <MenuDivider />}
          {residents.map((a) => (
            <MenuItem key={a.id} icon={<Bot20Regular />} onClick={handleAssign(residentPrincipalId(a.id))}>
              {a.name}
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
