import { useStore } from '@nanostores/react';
import { Filter } from 'lucide-react';
import { memo, useCallback } from 'react';

import { residentPrincipalId } from '@/lib/resident-agent';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
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

  const handleCheckedChange = useCallback((value: string) => $assigneeFilter.set(value), []);

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
          <Filter />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={filter} onValueChange={handleCheckedChange}>
          <DropdownMenuRadioItem value="all">All assignees</DropdownMenuRadioItem>
          {me ? <DropdownMenuRadioItem value="me">Assigned to me</DropdownMenuRadioItem> : null}
          <DropdownMenuRadioItem value="unassigned">Unassigned</DropdownMenuRadioItem>
          {members.length > 0 && <DropdownMenuSeparator />}
          {members.map((m) => (
            <DropdownMenuRadioItem key={m.userId} value={m.userId}>
              {m.displayName ?? m.email ?? m.userId}
            </DropdownMenuRadioItem>
          ))}
          {residents.length > 0 && <DropdownMenuSeparator />}
          {residents.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={residentPrincipalId(a.id)}>
              {a.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
