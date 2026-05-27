/**
 * Server-side team authorization. RLS isolates *data* by team; capability gates
 * (who may edit the team base, invite, change roles) are enforced here because
 * they can't be expressed cleanly in a row policy. The renderer only hides/
 * disables admin UI — the server is the boundary.
 */
import type { ControlPlaneRepo, TeamRole } from 'omni-projects-db';

const RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

export class TeamAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamAuthorizationError';
  }
}

/**
 * Throw unless `principal` holds at least `min` role in `teamId`. Returns the
 * caller's role on success.
 */
export async function requireRole(
  controlPlane: ControlPlaneRepo,
  teamId: string,
  principal: string,
  min: TeamRole
): Promise<TeamRole> {
  const role = await controlPlane.getMembershipRole(teamId, principal);
  if (!role || RANK[role] < RANK[min]) {
    throw new TeamAuthorizationError(
      `requires '${min}' in team ${teamId} (caller is '${role ?? 'non-member'}')`
    );
  }
  return role;
}
