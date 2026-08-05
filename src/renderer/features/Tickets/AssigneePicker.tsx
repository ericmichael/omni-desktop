import { useStore } from '@nanostores/react';
import { Bot, User } from 'lucide-react';
import { memo, useCallback, useEffect } from 'react';

import { residentPrincipalId } from '@/lib/resident-agent';
import { Button } from '@/renderer/ds/ui/button';
/**
 * Assign a ticket to a team member or a resident agent, or leave it
 * Unassigned (the default). Ownership stays with the team — this only sets
 * the optional `assignee` pointer that drives the "my work" filters and, for
 * residents (`agent:<id>`), the assignment wakeup. Any team member may
 * reassign. In single-user/local mode the member list is empty, so the
 * options are Unassigned + the resident roster.
 */ import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { $members, loadMembers } from '@/renderer/features/Teams/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { TeamMember, TicketId } from '@/shared/types';
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

  const handleAssign = useCallback(
    (principalId: string) => void ticketApi.assignTicket(ticketId, principalId || null),
    [ticketId]
  );

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Assign ticket">
          {currentResident ? <Bot /> : <User />}
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={assignee ?? ''} onValueChange={handleAssign}>
          <DropdownMenuRadioItem value="">Unassigned</DropdownMenuRadioItem>
          {members.map((m) => (
            <DropdownMenuRadioItem key={m.userId} value={m.userId}>
              {memberLabel(m)}
            </DropdownMenuRadioItem>
          ))}
          {residents.length > 0 && <DropdownMenuSeparator />}
          {residents.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={residentPrincipalId(a.id)}>
              <Bot />
              {a.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

function memberLabel(m: TeamMember): string {
  return m.displayName ?? m.email ?? m.userId;
}
