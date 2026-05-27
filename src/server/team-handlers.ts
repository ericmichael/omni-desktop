/**
 * Teams control-plane IPC (cloud only). Membership reads are scoped to the
 * caller's principal; mutations are role-gated via {@link requireRole}. When no
 * control plane exists (SQLite/local), every channel is a graceful no-op so the
 * renderer's Teams UI degrades to "just you".
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { ControlPlaneRepo } from 'omni-projects-db';

import { requireRole } from '@/server/authz';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { TeamInvitation, TeamMember, TeamRole, TeamSummary } from '@/shared/types';

/**
 * Register team channels. `controlPlane` is undefined in Electron/SQLite/local,
 * where every channel is a graceful no-op. The `event` slot carries the
 * {@link HandlerContext} in server mode (principal + active team).
 */
export function registerTeamHandlers(ipc: IIpcListener, controlPlane: ControlPlaneRepo | undefined): void {
  const cp = controlPlane;

  const listTeams = async (principal: string): Promise<TeamSummary[]> => {
    if (!cp) return [];
    const rows = await cp.listTeamsForPrincipal(principal);
    return rows.map((r) => ({ id: r.id, label: r.label, kind: r.kind, role: r.role }));
  };

  const listMembers = async (teamId: string): Promise<TeamMember[]> => {
    if (!cp) return [];
    const rows = await cp.listMembers(teamId);
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
    }));
  };

  const listInvites = async (teamId: string): Promise<TeamInvitation[]> => {
    if (!cp) return [];
    const rows = await cp.listInvitations(teamId);
    return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, token: r.token }));
  };

  ipc.handle('team:list', (ctx) => listTeams(ctx.principalId));

  ipc.handle('team:get-my-role', async (ctx) => {
    if (!cp) return null;
    return (await cp.getMembershipRole(ctx.tenantId, ctx.principalId)) ?? null;
  });

  ipc.handle('team:create', async (ctx, label) => {
    if (!cp) return listTeams(ctx.principalId);
    await cp.createTeam({
      id: randomUUID(),
      label: String(label).trim() || 'New Team',
      kind: 'shared',
      ownerId: ctx.principalId,
    });
    return listTeams(ctx.principalId);
  });

  ipc.handle('team:invite', async (ctx, email, role) => {
    if (!cp) return [];
    await requireRole(cp, ctx.tenantId, ctx.principalId, 'admin');
    await cp.createInvitation({
      id: randomUUID(),
      teamId: ctx.tenantId,
      email: String(email),
      role: role === 'admin' ? 'admin' : 'member',
      invitedBy: ctx.principalId,
      token: randomBytes(24).toString('base64url'),
    });
    return listInvites(ctx.tenantId);
  });

  ipc.handle('team:accept-invite', async (ctx, token) => {
    if (!cp) return listTeams(ctx.principalId);
    await cp.acceptInvitation(String(token), ctx.principalId);
    return listTeams(ctx.principalId);
  });

  ipc.handle('team:revoke-invite', async (ctx, id) => {
    if (!cp) return [];
    await requireRole(cp, ctx.tenantId, ctx.principalId, 'admin');
    await cp.revokeInvitation(String(id), ctx.tenantId);
    return listInvites(ctx.tenantId);
  });

  ipc.handle('team:list-invites', async (ctx) => {
    if (!cp) return [];
    await requireRole(cp, ctx.tenantId, ctx.principalId, 'admin');
    return listInvites(ctx.tenantId);
  });

  ipc.handle('team:list-members', async (ctx) => {
    if (!cp) return [];
    // Any member may see the roster.
    await requireRole(cp, ctx.tenantId, ctx.principalId, 'member');
    return listMembers(ctx.tenantId);
  });

  ipc.handle('team:remove-member', async (ctx, userId) => {
    if (!cp) return [];
    await requireRole(cp, ctx.tenantId, ctx.principalId, 'admin');
    const target = String(userId);
    const targetRole = await cp.getMembershipRole(ctx.tenantId, target);
    if (targetRole === 'owner') {
      throw new Error('cannot remove the team owner');
    }
    await cp.removeMember(ctx.tenantId, target);
    return listMembers(ctx.tenantId);
  });

  ipc.handle('team:set-role', async (ctx, userId, role) => {
    if (!cp) return [];
    const next = role as TeamRole;
    // Promoting/demoting to or from owner is owner-only; other role changes are admin.
    const target = String(userId);
    const targetRole = await cp.getMembershipRole(ctx.tenantId, target);
    const min: TeamRole = next === 'owner' || targetRole === 'owner' ? 'owner' : 'admin';
    await requireRole(cp, ctx.tenantId, ctx.principalId, min);
    await cp.setRole(ctx.tenantId, target, next);
    return listMembers(ctx.tenantId);
  });
}
