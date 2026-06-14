/**
 * Teams control plane: users, teams, memberships, invitations.
 *
 * Accessed via the ADMIN pool (the schema owner), not the omni_app pool:
 * memberships must be read before a team/RLS-tenant is chosen, and privileged
 * writes (bootstrap a personal team, accept an invite, add a member) target
 * teams the caller isn't yet scoped to. The owner bypasses the (dormant) RLS on
 * these tables; isolation is enforced at the application layer — every read is
 * scoped by the authenticated principal, every mutation is capability-checked
 * server-side (see src/server/authz.ts). Project/settings data stays on the
 * RLS-enforced omni_app pool.
 */
import type { Pool } from 'pg';

export type TeamRole = 'owner' | 'admin' | 'member';

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  idp: string | null;
}

export interface TeamRow {
  id: string;
  label: string;
  kind: 'personal' | 'shared';
  created_by: string;
}

export interface TeamMembershipRow {
  team_id: string;
  user_id: string;
  role: TeamRole;
}

/** A team plus the caller's role in it. */
export interface TeamWithRole extends TeamRow {
  role: TeamRole;
}

export interface InvitationRow {
  id: string;
  team_id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string;
  token: string;
  status: 'pending' | 'accepted' | 'revoked';
}

export class ControlPlaneRepo {
  /** @param pool the ADMIN (schema-owner) pool — bypasses the dormant RLS here. */
  constructor(private readonly pool: Pool) {}

  // ---- Users ----

  async ensureUser(
    id: string,
    profile: { email?: string | null; displayName?: string | null; idp?: string | null } = {}
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, email, display_name, idp) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, users.email),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         idp = COALESCE(EXCLUDED.idp, users.idp),
         updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
      [id, profile.email ?? null, profile.displayName ?? null, profile.idp ?? null]
    );
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query<UserRow>('SELECT id, email, display_name, idp FROM users WHERE id = $1', [
      id,
    ]);
    return rows[0];
  }

  // ---- Teams + membership ----

  /** Create a team and make `ownerId` its owner. Idempotent on team id. */
  async createTeam(team: { id: string; label: string; kind: 'personal' | 'shared'; ownerId: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO teams (id, label, kind, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [team.id, team.label, team.kind, team.ownerId]
    );
    await this.addMember(team.id, team.ownerId, 'owner');
  }

  async getTeam(id: string): Promise<TeamRow | undefined> {
    const { rows } = await this.pool.query<TeamRow>('SELECT id, label, kind, created_by FROM teams WHERE id = $1', [
      id,
    ]);
    return rows[0];
  }

  async renameTeam(id: string, label: string): Promise<void> {
    await this.pool.query(
      `UPDATE teams SET label = $2,
         updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')
       WHERE id = $1`,
      [id, label]
    );
  }

  /**
   * Delete a team and its membership/invitations/settings (FK-cascaded). Project
   * DATA (keyed by tenant_id, not FK-linked) is NOT removed here — callers must
   * ensure the team is empty first. Personal teams cannot be deleted.
   */
  async deleteTeam(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM teams WHERE id = $1 AND kind <> 'personal'`, [id]);
  }

  /** Teams the principal belongs to, with their role, personal team first. */
  async listTeamsForPrincipal(principal: string): Promise<TeamWithRole[]> {
    const { rows } = await this.pool.query<TeamWithRole>(
      `SELECT t.id, t.label, t.kind, t.created_by, m.role
         FROM teams t JOIN team_members m ON m.team_id = t.id
        WHERE m.user_id = $1
        ORDER BY (t.kind = 'personal') DESC, t.label`,
      [principal]
    );
    return rows;
  }

  /** The principal's role in a team, or undefined if not a member. */
  async getMembershipRole(teamId: string, principal: string): Promise<TeamRole | undefined> {
    const { rows } = await this.pool.query<{ role: TeamRole }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, principal]
    );
    return rows[0]?.role;
  }

  async listMembers(
    teamId: string
  ): Promise<Array<TeamMembershipRow & { email: string | null; display_name: string | null }>> {
    const { rows } = await this.pool.query(
      `SELECT m.team_id, m.user_id, m.role, u.email, u.display_name
         FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1
        ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, u.email`,
      [teamId]
    );
    return rows as Array<TeamMembershipRow & { email: string | null; display_name: string | null }>;
  }

  async addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [teamId, userId, role]
    );
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  }

  async setRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await this.pool.query('UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2', [
      teamId,
      userId,
      role,
    ]);
  }

  // ---- Invitations ----

  async createInvitation(inv: {
    id: string;
    teamId: string;
    email: string;
    role: 'admin' | 'member';
    invitedBy: string;
    token: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO invitations (id, team_id, email, role, invited_by, token)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inv.id, inv.teamId, inv.email.toLowerCase(), inv.role, inv.invitedBy, inv.token]
    );
  }

  async getPendingInvitationByToken(token: string): Promise<InvitationRow | undefined> {
    const { rows } = await this.pool.query<InvitationRow>(
      `SELECT id, team_id, email, role, invited_by, token, status FROM invitations
        WHERE token = $1 AND status = 'pending'`,
      [token]
    );
    return rows[0];
  }

  async listInvitations(teamId: string): Promise<InvitationRow[]> {
    const { rows } = await this.pool.query<InvitationRow>(
      `SELECT id, team_id, email, role, invited_by, token, status FROM invitations
        WHERE team_id = $1 AND status = 'pending' ORDER BY created_at`,
      [teamId]
    );
    return rows;
  }

  /** Accept a pending invitation: add membership + mark accepted. */
  async acceptInvitation(token: string, userId: string): Promise<TeamRow | undefined> {
    const inv = await this.getPendingInvitationByToken(token);
    if (!inv) {
      return undefined;
    }
    await this.addMember(inv.team_id, userId, inv.role);
    await this.pool.query(
      `UPDATE invitations SET status = 'accepted',
         accepted_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')
       WHERE id = $1`,
      [inv.id]
    );
    return this.getTeam(inv.team_id);
  }

  async revokeInvitation(id: string, teamId: string): Promise<void> {
    await this.pool.query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND team_id = $2 AND status = 'pending'`,
      [id, teamId]
    );
  }
}
