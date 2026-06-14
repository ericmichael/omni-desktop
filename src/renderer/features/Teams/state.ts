import { atom } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import { getActiveTeamId, setActiveTeamId } from '@/renderer/transport/ws-transport';
import type { TeamDefaultsStatus, TeamInvitation, TeamMember, TeamRole, TeamSummary } from '@/shared/types';

/** Teams the current user belongs to (empty in single-user/local mode). */
export const $teams = atom<TeamSummary[]>([]);
/** The active team id (from the WS scope / localStorage), or null. */
export const $activeTeamId = atom<string | null>(getActiveTeamId());
/** The current user's role in the active team. */
export const $myRole = atom<TeamRole | null>(null);
/** This user's principal id in teams/cloud mode; null in single-user/local. Drives "my work" filters. */
export const $currentPrincipal = atom<string | null>(null);

/** Load the current principal once at boot (no-op/null in local mode). */
export async function loadWhoami(): Promise<void> {
  try {
    $currentPrincipal.set(await emitter.invoke('team:whoami'));
  } catch {
    $currentPrincipal.set(null);
  }
}
/** Members of the active team (admin views). */
export const $members = atom<TeamMember[]>([]);
/** Pending invitations for the active team (admin views). */
export const $invites = atom<TeamInvitation[]>([]);

/** True once the user belongs to more than just a personal team, or any shared team. */
export const teamsAvailable = (): boolean => $teams.get().some((t) => t.kind === 'shared') || $teams.get().length > 1;

export async function loadTeams(): Promise<void> {
  try {
    const [teams, role] = await Promise.all([emitter.invoke('team:list'), emitter.invoke('team:get-my-role')]);
    $teams.set(teams);
    $myRole.set(role);
    // Default the active team to the personal team if none is set.
    if (!$activeTeamId.get() && teams.length > 0) {
      const personal = teams.find((t) => t.kind === 'personal') ?? teams[0];
      if (personal) {
        $activeTeamId.set(personal.id);
      }
    }
  } catch {
    // Single-user/local mode — no teams. Leave defaults.
  }
}

export function switchTeam(teamId: string): void {
  setActiveTeamId(teamId); // persists + reloads to re-dial /ws with the new scope
}

export async function createTeam(label: string): Promise<void> {
  $teams.set(await emitter.invoke('team:create', label));
}

export async function renameTeam(label: string): Promise<void> {
  $teams.set(await emitter.invoke('team:rename', label));
}

export async function leaveTeam(): Promise<void> {
  const remaining = await emitter.invoke('team:leave');
  $teams.set(remaining);
  // Drop into a remaining team (personal first) so the app stays scoped somewhere.
  const next = remaining.find((t) => t.kind === 'personal') ?? remaining[0];
  if (next) {
    switchTeam(next.id);
  }
}

export async function deleteTeam(): Promise<void> {
  const remaining = await emitter.invoke('team:delete');
  $teams.set(remaining);
  const next = remaining.find((t) => t.kind === 'personal') ?? remaining[0];
  if (next) {
    switchTeam(next.id);
  }
}

export async function transferOwnership(userId: string): Promise<void> {
  $members.set(await emitter.invoke('team:transfer-ownership', userId));
  await loadTeams(); // my role changed (owner → admin)
}

export async function loadMembers(): Promise<void> {
  try {
    $members.set(await emitter.invoke('team:list-members'));
  } catch {
    $members.set([]);
  }
}

export async function loadInvites(): Promise<void> {
  try {
    $invites.set(await emitter.invoke('team:list-invites'));
  } catch {
    $invites.set([]);
  }
}

export async function inviteMember(email: string, role: 'admin' | 'member'): Promise<void> {
  $invites.set(await emitter.invoke('team:invite', email, role));
}

export async function revokeInvite(id: string): Promise<void> {
  $invites.set(await emitter.invoke('team:revoke-invite', id));
}

export async function acceptInvite(token: string): Promise<void> {
  $teams.set(await emitter.invoke('team:accept-invite', token));
}

export async function removeMember(userId: string): Promise<void> {
  $members.set(await emitter.invoke('team:remove-member', userId));
}

export async function setMemberRole(userId: string, role: TeamRole): Promise<void> {
  $members.set(await emitter.invoke('team:set-role', userId, role));
}

/** Whether the team has shared agent-config defaults set. */
export const $teamDefaults = atom<TeamDefaultsStatus>({
  hasModels: false,
  hasMcp: false,
  hasEnv: false,
  hasNetwork: false,
});

export async function loadTeamDefaults(): Promise<void> {
  try {
    $teamDefaults.set(await emitter.invoke('team-settings:status'));
  } catch {
    /* local mode */
  }
}

export async function publishTeamDefaults(): Promise<void> {
  $teamDefaults.set(await emitter.invoke('team-settings:publish-from-mine'));
}

export async function clearTeamDefaults(): Promise<void> {
  $teamDefaults.set(await emitter.invoke('team-settings:clear'));
}
